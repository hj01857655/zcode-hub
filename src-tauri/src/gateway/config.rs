// GATEWAY 配置：端口、调用方鉴权密钥，落 ~/.zcode-hub/gateway.json（与账号库同目录）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
    /// 上游连接超时（秒）。读超时不设：SSE 流式回答持续几分钟是正常形态，整体超时会掐断流
    #[serde(default = "d_connect")]
    pub upstream_connect_secs: u64,
    /// 换号重试次数（首次尝试之外）
    #[serde(default = "d_retries")]
    pub max_retries: u32,
    /// 账号粘性：开 = 成功后驻留同号（上游 prompt cache 命中），关 = 每请求轮换分摊
    #[serde(default = "d_true")]
    pub sticky: bool,
    /// 3012 等全局风控后的整体退避（秒）
    #[serde(default = "d_backoff")]
    pub global_backoff_secs: u64,
    /// 连续失败熔断：同一账号在本进程内连续失败 N 次即强制冷却（0 = 关闭）。
    /// 持续坏掉的号没有这项时会一直被打，本项兜底下线
    #[serde(default = "d_allowed_fails")]
    pub allowed_fails: u32,
    /// SSE keepalive（秒）：上游静默超过该时长时向客户端发 ": ping" 注释帧，防中间层掐空闲连接（0 = 关闭）
    #[serde(default = "d_keepalive")]
    pub keepalive_secs: u64,
    /// 整体请求超时（秒）：从收到请求到响应结束的兜底上限，防请求永久挂死（0 = 不设）。
    /// 默认 600s 远大于正常流式回答，只拦真正的挂死
    #[serde(default = "d_total_timeout")]
    pub total_timeout_secs: u64,
    /// 跟随应用自启：start/stop 时落盘，应用启动时按此恢复
    #[serde(default)]
    pub auto_start: bool,
    /// CORS 允许来源（精确匹配；"*" 放行全部）。空 = 不发 CORS 头，浏览器端调用会被拦，本机 CLI 无感
    #[serde(default)]
    pub cors_origins: Vec<String>,
    /// 单请求体上限（MB）。axum 默认 2MB，大上下文对话会被掐，默认放宽到 32
    #[serde(default = "d_body_limit")]
    pub body_limit_mb: u64,
    /// 请求日志是否落盘 gateway.jsonl
    #[serde(default = "d_true")]
    pub log_to_disk: bool,
    /// 日志文件超过此大小（MB）轮转为 gateway.jsonl.1
    #[serde(default = "d_log_max")]
    pub log_file_max_mb: u64,
    /// 上游供应商清单（首个 = 默认上游，现有路由继续走它；结构为多上游预留）
    #[serde(default = "d_providers")]
    pub providers: Vec<ProviderConfig>,
}

/// 上游供应商：magpie 式供应商页的数据模型——条目可展开、可拉模型、可右键测试
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 调用该上游的凭据（zcode 上游为账号池 token，此处仅存展示用占位；掩码显示）
    #[serde(default)]
    pub api_key: String,
    /// 「获取模型」的结果缓存
    #[serde(default)]
    pub models: Vec<String>,
}

impl ProviderConfig {
    /// 默认上游：现有网关行为不动，只是把硬编码的 zcode.z.ai 收进结构
    pub fn zcode_default() -> Self {
        Self {
            id: "zcode".into(),
            name: "ZCode".into(),
            base_url: "https://zcode.z.ai".into(),
            api_key: String::new(),
            models: vec!["GLM-5.3-Flash".into(), "GLM-5.3".into()],
        }
    }
}

fn d_providers() -> Vec<ProviderConfig> { vec![ProviderConfig::zcode_default()] }

fn d_connect() -> u64 { 15 }
fn d_retries() -> u32 { 1 }
fn d_backoff() -> u64 { 600 }
fn d_body_limit() -> u64 { 32 }
fn d_true() -> bool { true }
fn d_log_max() -> u64 { 16 }
fn d_allowed_fails() -> u32 { 5 }
fn d_keepalive() -> u64 { 15 }
fn d_total_timeout() -> u64 { 600 }

impl Default for GatewayConfig {
    fn default() -> Self {
        // 密钥默认自动生成（sk- + 32 hex），首次落盘后固定
        Self {
            port: 8081,
            api_key: format!("sk-{}", uuid::Uuid::new_v4().simple()),
            upstream_connect_secs: d_connect(),
            max_retries: d_retries(),
            sticky: d_true(),
            global_backoff_secs: d_backoff(),
            allowed_fails: d_allowed_fails(),
            keepalive_secs: d_keepalive(),
            total_timeout_secs: d_total_timeout(),
            auto_start: false,
            // 默认全放行：网关绑 127.0.0.1，空列表会把所有浏览器跨源
            // （Vite dev 5173 等）的预检全拒掉。要收紧走配置面 cors_origins。
            cors_origins: vec!["*".to_string()],
            body_limit_mb: d_body_limit(),
            log_to_disk: d_true(),
            log_file_max_mb: d_log_max(),
            providers: d_providers(),
        }
    }
}

impl GatewayConfig {
    fn path() -> PathBuf {
        crate::Paths::detect().store_dir().join("gateway.json")
    }

    pub fn load() -> Self {
        let p = Self::path();
        if p.exists() {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str(&s) {
                    return v;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let p = Self::path();
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        Ok(())
    }
}
