
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

const MAX_BYTES: u64 = 256 * 1024;

pub fn init(base: &Path) {
    let dir = base.join("logs");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = LOG_PATH.set(dir.join("oauth.log"));
    }
}

/// 单行日志的 JSONL 形态：公共字段 ts/flow/event + 互斥负载——普通事件走
/// detail（单字符串），HTTP 事件走 method/url/status/ms/body 五字段（body 恒为
/// wire 原文的转义字符串，不做嵌套 JSON 对象：保留上游键序/空白形态作排障
/// 证据，且非 JSON 体（WAF HTML/网络错文本）与合法 JSON 类型统一）。
/// None 字段跳过序列化，行内只出现实际有值的键。
#[derive(serde::Serialize)]
struct LogLine<'a> {
    ts: String,
    flow: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
}

fn now_ts() -> String {
    // 毫秒精度：同秒内多条日志（req/resp 对、批量轮询）的排序确定性依赖它
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

pub fn log(flow: &str, event: &str, detail: &str) {
    append_line(&LogLine {
        ts: now_ts(),
        flow,
        event,
        detail: (!detail.is_empty()).then_some(detail),
        method: None,
        url: None,
        status: None,
        ms: None,
        body: None,
    });
}

/// HTTP 事件专用落行（status/ms/body 可选：请求行 http-req 只有 method/url/body，
/// 网络错行 status=0 无 body，正常响应行全量）。调用方负责 body 的截断策略
/// （见 httplog::body_for_log），本层只管结构与转义。
#[allow(clippy::too_many_arguments)]
pub fn log_http(
    flow: &str,
    event: &str,
    method: &str,
    url: &str,
    status: Option<u16>,
    ms: Option<u64>,
    body: Option<&str>,
) {
    append_line(&LogLine {
        ts: now_ts(),
        flow,
        event,
        detail: None,
        method: Some(method),
        url: Some(url),
        status,
        ms,
        body,
    });
}

fn append_line(line: &LogLine) {
    let Some(path) = LOG_PATH.get() else { return };
    match serde_json::to_string(line) {
        Ok(mut s) => {
            s.push('\n');
            append(path, &s);
        }
        // 序列化失败极罕见（含非法标量），降级文本行保留事件痕迹
        Err(_) => append(path, &format!("{} [{}] {} 序列化失败\n", now_ts(), line.flow, line.event)),
    }
}

/// 读取日志尾部 n 行（系统日志页数据源；文件不存在返回空 Vec）。
/// 行格式：JSONL（LogLine 序列化），前端按 JSON.parse 解析。
pub fn tail(n: usize) -> Vec<String> {
    let Some(path) = LOG_PATH.get() else { return vec![] };
    let Ok(content) = std::fs::read_to_string(path) else { return vec![] };
    let mut lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    if total > n {
        lines.drain(0..total - n);
    }
    lines.into_iter().map(str::to_string).collect()
}

fn append(path: &Path, line: &str) {
    let _guard = match WRITE_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let old = path.with_extension("log.old");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(path, &old);
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = f.write_all(line.as_bytes());
}
