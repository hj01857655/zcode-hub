// 应用内版本回退：pinned 到不可变 tag 的 latest.json，覆盖 updater 端点与版本比较器。
//
// 常规更新走 tauri.conf.json 的 /releases/latest/download/latest.json，默认比较器只装更高版本。
// 回退必须自己构造 Updater：端点固定为 https://github.com/.../releases/download/v{ver}/latest.json，
// 比较器只接受「恰好等于所选版本且低于当前版本」，并由插件继续用 pubkey 校验产物签名。
// 端点 JSON 本身不签名，所以额外校验 download_url 的 host + tag 路径前缀与 raw_json.version，
// 避免被篡改的端点把低版本有效签名与任意产物配对。

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "hj01857655/zcode-hub";
const ATOM_URL: &str = "https://github.com/hj01857655/zcode-hub/releases.atom";
// 离线或 GitHub feed 不可用时兜底：这些 tag 的 pinned latest.json 均已实测含 windows-x86_64-nsis。
const FALLBACK_TAGS: &[&str] = &[
    "1.10.405", "1.10.404", "1.10.403", "1.10.402", "1.10.401", "1.10.4", "1.10.3",
];
const MAX_VERSIONS: usize = 8;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackVersion {
    pub version: String,
    pub tag: String,
    pub published: String,
    pub endpoint: String,
}

#[derive(Clone, Serialize)]
pub struct RollbackProgress {
    pub event: &'static str,
    pub data: serde_json::Value,
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let rest = s.split_once(open)?.1;
    Some(rest.split(close).next().unwrap_or(""))
}

/// 只接受纯数字三段版本，拒绝 tag 注入（`/`、`-`、空格、pre-release 等）。
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut out = [0u64; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some((out[0], out[1], out[2]))
}

fn pinned_endpoint(version: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/v{version}/latest.json")
}

fn push_version(list: &mut Vec<RollbackVersion>, current: (u64, u64, u64), raw: &str, published: &str) {
    let v = raw.trim().trim_start_matches('v');
    let Some(ver) = parse_version(v) else { return };
    if ver >= current || list.iter().any(|x| x.version == v) {
        return;
    }
    list.push(RollbackVersion {
        version: v.to_string(),
        tag: format!("v{v}"),
        published: published.chars().take(10).collect(),
        endpoint: pinned_endpoint(v),
    });
}

/// 历史版本列表：优先 GitHub releases.atom（无 API 限额），失败回退内置最近 tag。
/// 只返回严格低于当前版本的稳定三段版本号，避免把当前版本/预发布列进去。
#[tauri::command]
pub async fn rollback_versions(app: AppHandle) -> Result<Vec<RollbackVersion>, String> {
    let current = parse_version(&app.package_info().version.to_string())
        .ok_or_else(|| "rollback: invalid current version".to_string())?;
    let mut list = Vec::new();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("zcode-hub-rollback")
        .build()
        .map_err(|e| e.to_string())?;
    let feed = async {
        let body = client
            .get(ATOM_URL)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        Ok::<String, String>(body)
    }
    .await;

    match feed {
        Ok(body) => {
            for entry in body.split("<entry>").skip(1) {
                let title = between(entry, "<title>", "</title>").unwrap_or("").trim();
                let updated = between(entry, "<updated>", "</updated>").unwrap_or("").trim();
                // 形如 "Z·HUB v1.10.405"，取最后一段以免产品名里的 v 干扰
                let raw = title.split_whitespace().last().unwrap_or("");
                push_version(&mut list, current, raw, updated);
                if list.len() >= MAX_VERSIONS {
                    break;
                }
            }
        }
        Err(e) => {
            crate::flowlog::log("rollback", "feed-fail", &e.chars().take(120).collect::<String>());
        }
    }

    if list.is_empty() {
        for v in FALLBACK_TAGS {
            push_version(&mut list, current, v, "");
            if list.len() >= MAX_VERSIONS {
                break;
            }
        }
    }
    Ok(list)
}

/// 下载并安装指定历史版本。进度经 Channel 推给前端；Windows 下安装器会自行退出并重启进程，
/// 因此「Finished」事件在下载完成（签名校验/安装之前）就发出，供前端切到「安装中」状态。
#[tauri::command]
pub async fn rollback_to(
    app: AppHandle,
    version: String,
    on_event: tauri::ipc::Channel<RollbackProgress>,
) -> Result<(), String> {
    let current_raw = app.package_info().version.to_string();
    let current = parse_version(&current_raw)
        .ok_or_else(|| "rollback: invalid current version".to_string())?;
    let target = parse_version(&version)
        .ok_or_else(|| "rollback: invalid target version".to_string())?;
    if target >= current {
        return Err("rollback: target version must be lower than current".to_string());
    }

    let endpoint = pinned_endpoint(&version);
    // reqwest::Url 是 url::Url 的 re-export，与 tauri-plugin-updater 的 endpoints 参数同类型。
    let url = reqwest::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let want = version.clone();
    let builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .version_comparator(move |cur, release| {
            release.version.to_string() == want && release.version < cur
        });
    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("rollback: no updater package for v{version}"))?;

    // 端点 JSON 不签名：校验公告版本、产物 URL 的 host 与不可变 tag 路径，防止降级到任意产物。
    if update.version != version {
        return Err(format!(
            "rollback: endpoint version mismatch ({} != {version})",
            update.version
        ));
    }
    if update.raw_json.get("version").and_then(|v| v.as_str()) != Some(version.as_str()) {
        return Err("rollback: endpoint JSON version mismatch".to_string());
    }
    let expected_prefix = format!("/{REPO}/releases/download/v{version}/");
    if update.download_url.host_str() != Some("github.com")
        || !update.download_url.path().starts_with(&expected_prefix)
    {
        return Err("rollback: untrusted download URL for pinned tag".to_string());
    }
    if update.signature.trim().is_empty() {
        return Err("rollback: missing signature for pinned tag".to_string());
    }

    let evt_start = on_event.clone();
    let evt_chunk = on_event.clone();
    let evt_finish = on_event.clone();
    let mut first = true;
    update
        .download_and_install(
            move |chunk, total| {
                if first {
                    first = false;
                    let _ = evt_start.send(RollbackProgress {
                        event: "Started",
                        data: serde_json::json!({ "contentLength": total }),
                    });
                }
                let _ = evt_chunk.send(RollbackProgress {
                    event: "Progress",
                    data: serde_json::json!({ "chunkLength": chunk }),
                });
            },
            move || {
                let _ = evt_finish.send(RollbackProgress {
                    event: "Finished",
                    data: serde_json::Value::Null,
                });
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parser_is_strict() {
        assert_eq!(parse_version("1.10.405"), Some((1, 10, 405)));
        assert_eq!(parse_version("1.10.4"), Some((1, 10, 4)));
        assert_eq!(parse_version("v1.10.405"), None);
        assert_eq!(parse_version("1.10.405-beta.1"), None);
        assert_eq!(parse_version("1.10.405/../../evil"), None);
        assert_eq!(parse_version("1..10"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_order_is_numeric() {
        assert!(parse_version("1.10.4").unwrap() < parse_version("1.10.401").unwrap());
        assert!(parse_version("1.10.405").unwrap() < parse_version("1.10.406").unwrap());
        assert!(parse_version("1.10.406").unwrap() >= parse_version("1.10.406").unwrap());
    }

    #[test]
    fn pinned_endpoint_is_immutable_tag() {
        assert_eq!(
            pinned_endpoint("1.10.405"),
            "https://github.com/hj01857655/zcode-hub/releases/download/v1.10.405/latest.json"
        );
    }

    #[test]
    fn atom_entry_title_parses() {
        let entry = r#"<entry><id>tag:github.com,2008:Repository/1/v1.10.405</id>
<updated>2026-11-08T16:12:26Z</updated><title>Z·HUB v1.10.405</title></entry>"#;
        let title = between(entry, "<title>", "</title>").unwrap().trim();
        let raw = title.split_whitespace().last().unwrap();
        assert_eq!(raw.trim_start_matches('v'), "1.10.405");
        assert_eq!(
            between(entry, "<updated>", "</updated>").unwrap().trim().chars().take(10).collect::<String>(),
            "2026-11-08"
        );
    }

    #[test]
    fn only_lower_versions_are_listed() {
        let mut list = Vec::new();
        push_version(&mut list, (1, 10, 406), "v1.10.405", "2026-11-08T00:00:00Z");
        push_version(&mut list, (1, 10, 406), "v1.10.406", "2026-11-10T00:00:00Z");
        push_version(&mut list, (1, 10, 406), "v1.10.407", "2026-11-12T00:00:00Z");
        push_version(&mut list, (1, 10, 406), "v1.10.405", "2026-11-08T00:00:00Z");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "1.10.405");
        assert_eq!(list[0].published, "2026-11-08");
    }
}
