
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

pub fn log(flow: &str, event: &str, detail: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    append(path, &format_line(flow, event, detail));
}

/// 读取日志尾部 n 行（系统日志页数据源；文件不存在返回空 Vec）。
/// 行格式与 format_line 一致：`ts [flow] event detail`，前端按 [flow] 分组过滤。
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

fn format_line(flow: &str, event: &str, detail: &str) -> String {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let tag: String = flow.chars().take(8).collect();
    let clean: String = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        format!("{ts} [{tag}] {event}\n")
    } else {
        format!("{ts} [{tag}] {event} {clean}\n")
    }
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
