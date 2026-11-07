pub mod cipher;
pub mod cli;
pub mod i18n;
mod claim;
mod flowlog;
mod oauth;
mod probe;
mod quota;
mod referral;
mod store;
pub mod gateway;
mod zcrypto;

use serde_json::{json, Value};
use std::sync::Mutex;
use store::*;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::AutoLaunchManager;
use tauri_plugin_dialog::DialogExt;

const TRAY_ID: &str = "main";

static STORE_LOCK: Mutex<()> = Mutex::new(());

struct PendingClaim {
    account_id: String,
    account_name: String,
    plan_id: String,
    plan_name: String,
    credentials: Value,
    config: Option<Value>,
    device_mid: String,
    /// 投放 campaign 标识：领取成功后上报 touch/action 用（对齐桌面端）
    campaign_id: Option<String>,
}

static PENDING_CLAIM: Mutex<Option<PendingClaim>> = Mutex::new(None);

struct PendingBind {
    account_id: String,
    account_name: String,
    invite_code: String,
    credentials: Value,
    config: Option<Value>,
    device_mid: String,
}

static PENDING_BIND: Mutex<Option<PendingBind>> = Mutex::new(None);

fn pending_bind_guard() -> std::sync::MutexGuard<'static, Option<PendingBind>> {
    match PENDING_BIND.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn pending_guard() -> std::sync::MutexGuard<'static, Option<PendingClaim>> {
    match PENDING_CLAIM.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn store_guard() -> std::sync::MutexGuard<'static, ()> {
    match STORE_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

/// captcha 子窗口只加载第三方验证码 SDK（阿里 CDN 动态注入），不经窗口隔离的
/// 自定义命令就不是最小权限。该窗口唯一需要的是验证码流程本身的三个命令。
const CAPTCHA_ALLOWED_COMMANDS: &[&str] = &["get_state", "claim_captcha_config", "claim_captcha_submit"];

/// login 窗口加载的是外部 OAuth 页面（http(s)），与本地命令面完全隔离：
/// 第三方页面内容一律不授予任何 IPC 命令。
const LOGIN_WINDOW_LABEL: &str = "login";

fn ipc_command_gate<R: tauri::Runtime>(
    invoke: tauri::ipc::Invoke<R>,
) -> Option<tauri::ipc::Invoke<R>> {
    let command = invoke.message.command().to_string();
    let label = invoke.message.webview().label().to_string();
    let allowed = if label == LOGIN_WINDOW_LABEL {
        false
    } else if label == "captcha" {
        CAPTCHA_ALLOWED_COMMANDS.contains(&command.as_str())
    } else {
        true
    };
    if !allowed {
        invoke
            .resolver
            .reject(format!("ipc: command `{command}` is not allowed from window `{label}`"));
        return None;
    }
    Some(invoke)
}

/// generate_handler 产出的分发闭包对运行时泛型 R 推断失效（E0282），
/// 用泛型包装函数在签名上钉住 R 再喂给 invoke_handler。
fn gated_handler<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if let Some(invoke) = ipc_command_gate(invoke) {
            handler(invoke)
        } else {
            false
        }
    }
}

fn tray_menu_inner(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let paths = Paths::detect();
    let state = match store::get_state(&paths) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tray state error: {e}");
            return MenuBuilder::new(app)
                .item(&MenuItem::with_id(app, "show", &i18n::tr("tray.show"), true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "quit", &i18n::tr("tray.quit"), true, None::<&str>)?)
                .build();
        }
    };

    let b = MenuBuilder::new(app)
        .item(&MenuItem::with_id(app, "show", &i18n::tr("tray.show"), true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "capture", &i18n::tr("tray.capture"), state.live_logged_in, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "launch", &i18n::tr("tray.launch"), state.zcode_path_ok && !state.zcode_running, None::<&str>)?)
        .item(&MenuItem::with_id(app, "kill", &i18n::tr("tray.kill"), state.zcode_running, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "quit", &i18n::tr("tray.quit"), true, None::<&str>)?);
    b.build()
}

pub fn rebuild_tray(app: &AppHandle) {
    let app2 = app.clone();
    let res = app.run_on_main_thread(move || {
        if let Some(tray) = app2.tray_by_id(TRAY_ID) {
            let paths = Paths::detect();
            let tip = match store::get_state(&paths) {
                Ok(s) => {
                    let cur = s
                        .accounts
                        .iter()
                        .find(|a| a.is_active)
                        .map(|a| a.name.clone())
                        .or_else(|| s.live_identity.as_ref().and_then(|i| i.label()))
                        .unwrap_or_else(|| if s.live_logged_in { i18n::tr("tray.unsaved") } else { i18n::tr("tray.logged_out") });
                    format!("Z·SWITCH · {cur}")
                }
                Err(_) => "Z·SWITCH".into(),
            };
            let _ = tray.set_tooltip(Some(&tip));
            if let Ok(menu) = tray_menu_inner(&app2) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
    if let Err(e) = res {
        eprintln!("rebuild_tray: {e}");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn run_tray_action(app: AppHandle, action: String) {
    std::thread::spawn(move || {
        let paths = Paths::detect();
        let mut emit_payload = json!({ "action": action });
        let _guard = store_guard();
        let result: Result<serde_json::Value, String> = match action.as_str() {
            "capture" => store::capture_current(&paths, None).map(|a| json!({ "name": a.name })),
            "launch" => {
                let (p, ok) = effective_zcode_path(&paths);
                if ok { store::launch_zcode(&p).map(|_| json!({})) } else { Err(i18n::trf("err.zcode.path_invalid", &[("p", &p)])) }
            }
            "kill" => match store::kill_zcode() {
                Ok(true) => Ok(json!({})),
                Ok(false) => Err(i18n::tr("err.zcode.kill_timeout")),
                Err(e) => Err(e),
            },
            _ => Ok(json!({})),
        };
        match result {
            Ok(v) => {
                emit_payload["ok"] = json!(true);
                emit_payload["result"] = v;
            }
            Err(e) => {
                emit_payload["ok"] = json!(false);
                emit_payload["error"] = json!(e);
            }
        }
        let _ = app.emit("tray-action", &emit_payload);
        rebuild_tray(&app);
    });
}

#[tauri::command]
async fn get_state() -> Result<AppState, String> {
    store::get_state(&Paths::detect())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn capture_current(app: AppHandle, name: Option<String>) -> Result<Account, String> {
    let _guard = store_guard();
    let r = store::capture_current(&Paths::detect(), name);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn rename_account(app: AppHandle, id: String, name: String) -> Result<Account, String> {
    let _guard = store_guard();
    let r = store::rename_account(&Paths::detect(), &id, &name);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn delete_account(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = store_guard();
    let r = store::delete_account(&Paths::detect(), &id);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn update_account_from_live(app: AppHandle, id: String) -> Result<Account, String> {
    let _guard = store_guard();
    let r = store::update_account_from_live(&Paths::detect(), &id);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn switch_to(app: AppHandle, id: String, force: bool, restart: bool) -> Result<SwitchResult, String> {
    let _guard = store_guard();
    let paths = Paths::detect();
    let hot = load_settings(&paths).hot_switch();
    let r = store::switch_to(&paths, &id, force, restart, hot);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn get_live_quota() -> Result<quota::QuotaOverview, String> {
    // 阻塞 ureq + 429 退避重试，丢 blocking 池不占 runtime worker
    tauri::async_runtime::spawn_blocking(move || store::live_quota(&Paths::detect()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_account_quota(id: String) -> Result<quota::QuotaOverview, String> {
    tauri::async_runtime::spawn_blocking(move || store::account_quota(&Paths::detect(), &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claim_refresh_one(id: String) -> Result<Vec<claim::ClaimPlan>, String> {
    // 阻塞 ureq 丢入 blocking 线程池，不占 async runtime worker
    tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        let mid = store::ensure_virtual_device_mid(&paths, &id)?;
        let acc = load_account(&paths, &id)?;
        claim::claimable_plans(&paths.home, &acc.credentials, acc.config.as_ref(), Some(mid))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// touch 投放为空时的补充判定：balance 里是否有「已激活未生效」的套餐（领取待生效态）。
/// 独立命令而不是并入 claim_refresh_one：balance 是第二次网络请求，只在 touch 空时才值得打；
/// 失败返回 None 不报错——空态优先于错误态，不拿网络问题冒充「无可领」。
#[tauri::command]
async fn claim_pending_check(id: String) -> Result<Option<claim::ClaimedPending>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        let mid = store::ensure_virtual_device_mid(&paths, &id)?;
        let acc = load_account(&paths, &id)?;
        Ok(claim::claimed_pending(
            &paths.home,
            &acc.credentials,
            acc.config.as_ref(),
            Some(mid),
            &id,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claim_start(
    app: AppHandle,
    id: String,
    plan_id: String,
    auto: Option<bool>,
) -> Result<serde_json::Value, String> {
    let paths = Paths::detect();
    let mid = store::ensure_virtual_device_mid(&paths, &id)?;
    let acc = load_account(&paths, &id)?;
    let plans = claim::claimable_plans(&paths.home, &acc.credentials, acc.config.as_ref(), Some(mid.clone()))?;
    let plan = plans
        .iter()
        .find(|p| p.plan_id == plan_id)
        .ok_or_else(|| i18n::tr("err.claim.gone"))?;
    let display = if plan.name.is_empty() { plan.plan_id.clone() } else { plan.name.clone() };

    // 验证码窗口与提交入口与 referral bind 共用，发起时清掉对方 pending，防跨流程串扰
    *pending_bind_guard() = None;
    *pending_guard() = Some(PendingClaim {
        account_id: acc.id.clone(),
        account_name: acc.name.clone(),
        plan_id: plan.plan_id.clone(),
        plan_name: display.clone(),
        credentials: acc.credentials,
        config: acc.config,
        device_mid: mid,
        campaign_id: plan.campaign_id.clone(),
    });
    open_captcha_window(&app, auto.unwrap_or(false))?;
    Ok(json!({ "account": acc.name, "plan": display }))
}

#[tauri::command]
async fn claim_captcha_config() -> Result<claim::CaptchaConfig, String> {
    claim::fetch_captcha_config()
}

#[tauri::command]
async fn claim_captcha_submit(
    app: AppHandle,
    param: String,
    region: Option<String>,
) -> Result<serde_json::Value, String> {
    // 验证码子窗口只有一个提交入口；按当前待定态分发到 claim 或 referral bind
    let bind = pending_bind_guard().take();
    if let Some(pending) = bind {
        return submit_pending_bind(app, pending, param, region).await;
    }
    let pending = pending_guard().take().ok_or_else(|| i18n::tr("err.claim.none_pending"))?;
    // 阻塞提交（最长 25s）丢 blocking 线程池；pending 被 move，字段提前 clone 供结果组装
    let (aid, aname, pname) = (
        pending.account_id.clone(),
        pending.account_name.clone(),
        pending.plan_name.clone(),
    );
    // 领取成功后的 touch/report 上报素材（pending 被 move 进闭包，这里提前拆出）
    let rep_campaign = pending.campaign_id.clone();
    let rep_creds = pending.credentials.clone();
    let rep_config = pending.config.clone();
    let rep_mid = pending.device_mid.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        claim::submit_claim(
            &paths.home,
            &pending.credentials,
            pending.config.as_ref(),
            &pending.plan_id,
            &param,
            region.as_deref(),
            Some(pending.device_mid),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    close_captcha_window(&app);
    let payload = match res {
        Ok(v) => {
            let ms = |k: &str| -> Option<i64> {
                v.pointer(&format!("/data/plan/{k}"))
                    .and_then(|x| x.as_i64())
                    .map(|s| s * 1000)
            };
            let server_time = v
                .pointer("/data/server_time")
                .and_then(|x| x.as_i64())
                .map(|s| s * 1000);
            // 生效时刻权威来源：data.plan.entitlements[].effective_at（秒级，0=立即生效），
            // 取最早一条。与 starts_at（活动开始）彻底分开——老逻辑拿活动时间冒充生效时间
            // 会把「次日 0 点生效」显示成「19:00 放量时刻」。字段缺失 → None，前端走兜底文案。
            let effective_at = v
                .pointer("/data/plan/entitlements")
                .and_then(|e| e.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            e.get("effective_at")
                                .or_else(|| e.get("effectiveAt"))
                                .and_then(|x| x.as_i64())
                        })
                        .min()
                })
                .map(|s| if s == 0 { 0i64 } else { s * 1000 });
            let outcome = claim::ClaimOutcome {
                account_id: aid,
                account_name: aname,
                plan_name: pname,
                starts_at: ms("starts_at"),
                ends_at: ms("ends_at"),
                effective_at,
                server_time,
            };
            let p = serde_json::to_value(&outcome).unwrap_or(Value::Null);
            let _ = app.emit("claim://result", &p);
            // 桌面对齐（11-03 asar 实锤）：领取成功后上报投放动作 confirm；纯遥测，
            // 失败仅记日志不上抛——不影响领取结果
            if let Some(cid) = rep_campaign.as_deref() {
                let paths = Paths::detect();
                if let Err(e) = claim::touch_report(
                    &paths.home,
                    &rep_creds,
                    rep_config.as_ref(),
                    cid,
                    "confirm",
                    Some(rep_mid),
                ) {
                    eprintln!("[zsw] marketing/touch/action: {e}");
                }
            }
            p
        }
        Err(e) => {
            let p = claim::failure_payload(&aid, &aname, &pname, &e);
            let _ = app.emit("claim://result", &p);
            return Ok(p);
        }
    };
    Ok(payload)
}

#[tauri::command]
async fn claim_cancel(app: AppHandle) -> Result<(), String> {
    *pending_guard() = None;
    *pending_bind_guard() = None;
    close_captcha_window(&app);
    Ok(())
}

async fn submit_pending_bind(
    app: AppHandle,
    pending: PendingBind,
    param: String,
    region: Option<String>,
) -> Result<serde_json::Value, String> {
    // 阻塞提交丢 blocking 线程池；pending 被 move，字段提前 clone 供结果组装
    let (aid, aname, code) = (
        pending.account_id.clone(),
        pending.account_name.clone(),
        pending.invite_code.clone(),
    );
    let res = tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        referral::submit_bind(
            &paths.home,
            &pending.credentials,
            pending.config.as_ref(),
            &pending.invite_code,
            &param,
            region.as_deref(),
            Some(pending.device_mid),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    close_captcha_window(&app);
    let payload = match res {
        Ok(_) => json!({
            "ok": true,
            "accountId": aid,
            "accountName": aname,
            "inviteCode": code,
        }),
        Err(e) => json!({
            "ok": false,
            "accountId": aid,
            "accountName": aname,
            "inviteCode": code,
            "message": e,
        }),
    };
    let _ = app.emit("referral://result", &payload);
    Ok(payload)
}

#[tauri::command]
async fn referral_summary(id: String) -> Result<Value, String> {
    // 阻塞 ureq 丢入 blocking 线程池，不占 async runtime worker
    tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        let mid = store::ensure_virtual_device_mid(&paths, &id)?;
        let acc = load_account(&paths, &id)?;
        referral::summary(&paths.home, &acc.credentials, acc.config.as_ref(), Some(mid))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn referral_invitees(id: String) -> Result<Value, String> {
    // 阻塞 ureq 丢入 blocking 线程池，不占 async runtime worker
    tauri::async_runtime::spawn_blocking(move || {
        let paths = Paths::detect();
        let mid = store::ensure_virtual_device_mid(&paths, &id)?;
        let acc = load_account(&paths, &id)?;
        referral::invitees(&paths.home, &acc.credentials, acc.config.as_ref(), Some(mid))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn referral_bind_start(
    app: AppHandle,
    id: String,
    invite_code: String,
) -> Result<serde_json::Value, String> {
    let code = invite_code.trim().to_uppercase();
    if code.is_empty() {
        return Err(i18n::tr("err.referral.no_code").into());
    }
    let paths = Paths::detect();
    let mid = store::ensure_virtual_device_mid(&paths, &id)?;
    let acc = load_account(&paths, &id)?;
    // 验证码窗口与提交入口与 claim 共用，发起时清掉对方 pending，防跨流程串扰
    *pending_guard() = None;
    *pending_bind_guard() = Some(PendingBind {
        account_id: acc.id.clone(),
        account_name: acc.name.clone(),
        invite_code: code.clone(),
        credentials: acc.credentials,
        config: acc.config,
        device_mid: mid,
    });
    open_captcha_window(&app, false)?;
    Ok(json!({ "account": acc.name, "inviteCode": code }))
}

#[tauri::command]
async fn referral_bind_cancel(app: AppHandle) -> Result<(), String> {
    *pending_bind_guard() = None;
    close_captcha_window(&app);
    Ok(())
}

fn close_captcha_window(app: &AppHandle) {
    // 不能同步 destroy：验证码 SDK 此刻还有在途请求，wry 的自定义协议回调会往已销毁的
    // HWND 发 PostMessage，Windows 下刷一串 `PostMessage failed … 0x80070578 无效的窗口句柄`
    // （仅 debug 构建打印）。先隐窗 + window.stop() 掉在途加载，再隔一段延时销毁。
    // 不提前 clear pending：调用方（提交/取消路径）已自行清过，这里只负责拆窗。
    let Some(win) = app.get_webview_window("captcha") else {
        return;
    };
    let _ = win.hide();
    let _ = win.eval("try { window.stop() } catch (e) {}");
    let gen = CAPTCHA_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        // 窗口可能被其它命令重新打开/复用：代次变了就不关新窗
        if CAPTCHA_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
            return;
        }
        let a = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            if let Some(w) = a.get_webview_window("captcha") {
                // destroy 不触发 CloseRequested：程序化关窗（提交成功/取消）不能被误判成用户关窗
                let _ = w.destroy();
            }
        });
    });
}

struct PendingOAuth {
    provider: String,
    state: String,
    flow: String,
}

#[derive(Clone)]
struct PollCfg {
    url: String,
    token: String,
    expires_at_ms: u128,
    interval_ms: u64,
}

static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

fn pending_oauth_guard() -> std::sync::MutexGuard<'static, Option<PendingOAuth>> {
    match PENDING_OAUTH.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[tauri::command]
async fn oauth_providers() -> Result<Vec<oauth::OAuthProvider>, String> {
    Ok(oauth::OAUTH_PROVIDERS.to_vec())
}

#[tauri::command]
async fn oauth_begin(app: AppHandle, provider: String, browser: Option<bool>) -> Result<serde_json::Value, String> {
    if !oauth::OAUTH_PROVIDERS.iter().any(|p| p.id == provider) {
        return Err(i18n::trf("err.oauth.unknown_provider", &[("provider", &provider)]));
    }
    let proxy_url: Option<tauri::Url> = match load_settings(&Paths::detect()).auth_proxy() {
        Some(p) => {
            let norm = oauth::parse_proxy_url(p)?;
            Some(norm.parse::<tauri::Url>().map_err(|e| i18n::trf("err.proxy.invalid", &[("e", &e.to_string())]))?)
        }
        None => None,
    };
    *pending_oauth_guard() = None;
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.close();
    }
    let flow = uuid::Uuid::new_v4().to_string();
    flowlog::log(&flow, "begin", &format!("provider={provider} proxy={}", if proxy_url.is_some() { "on" } else { "off" }));
    let mid = uuid::Uuid::new_v4().to_string();
    let (p_init, m_init) = (provider.clone(), mid.clone());
    let init = match tauri::async_runtime::spawn_blocking(move || oauth::init_flow(&p_init, &m_init))
        .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            flowlog::log(&flow, "init-fail", &e);
            return Err(e);
        }
        Err(e) => {
            let m = i18n::trf("err.oauth.flow", &[("e", &e.to_string())]);
            flowlog::log(&flow, "init-fail", &m);
            return Err(m);
        }
    };
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let srv_flow = init.poll_url.rsplit('/').next().unwrap_or("");
        let expires_in = init.expires_at_ms.saturating_sub(now) / 1000;
        flowlog::log(
            &flow,
            "init-ok",
            &format!("server_flow={srv_flow} expires_in={expires_in}s interval={}ms", init.poll_interval_ms),
        );
    }
    let url = init.authorize_url.clone();
    let poll_cfg = PollCfg {
        url: init.poll_url.clone(),
        token: init.poll_token.clone(),
        expires_at_ms: init.expires_at_ms,
        interval_ms: init.poll_interval_ms,
    };
    *pending_oauth_guard() = Some(PendingOAuth {
        provider: provider.clone(),
        state: init.state.clone(),
        flow: flow.clone(),
    });

    // 系统浏览器模式（对应上游 #40）：不建内嵌窗，授权链接交给默认浏览器。
    // 入库只靠 poll 通道（Ready→persist_oauth_account），与窗口无关；
    // 若浏览器回调触发 zcode:// deep link 也走既有 pending 校验，双通道互斥是安全的。
    if browser.unwrap_or(false) {
        if let Err(e) = store::open_url(&url) {
            let m = i18n::trf("err.oauth.browser", &[("e", &e)]);
            *pending_oauth_guard() = None;
            flowlog::log(&flow, "browser-open-fail", &m);
            return Err(m);
        }
        flowlog::log(&flow, "browser-opened", "");
        spawn_poll_loop(app.clone(), provider.clone(), flow.clone(), mid, poll_cfg);
        return Ok(json!({ "opened": true, "browser": true, "provider": provider, "authorize_url": url }));
    }

    let login_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| i18n::trf("err.oauth.appdata", &[("e", &e.to_string())]))?
        .join("login-webview");
    sweep_login_profiles(&login_root);
    let profile_dir = login_root.join(&flow);

    let app2 = app.clone();
    let (provider2, state2, flow2, mid2) = (provider.clone(), init.state.clone(), flow.clone(), mid.clone());
    let flow_close = flow.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "login",
        tauri::WebviewUrl::External(url.parse::<tauri::Url>().map_err(|e| i18n::trf("err.oauth.bad_authorize_url", &[("e", &e.to_string())]))?),
    )
    .title(i18n::tr("title.login"))
    .theme(Some(tauri::Theme::Dark))
    .inner_size(480.0, 680.0)
    .min_inner_size(420.0, 560.0)
    .resizable(true)
    .user_agent(oauth::LOGIN_WINDOW_UA)
    .data_directory(profile_dir);
    if let Some(u) = proxy_url {
        builder = builder.proxy_url(u);
    }
    builder
    .on_navigation(move |url| {
        if url.scheme() != "zcode" {
            return true;
        }
        let full = url.to_string();
        let (app3, p3, s3, f3, m3) = (app2.clone(), provider2.clone(), state2.clone(), flow2.clone(), mid2.clone());
        tauri::async_runtime::spawn(async move {
            finish_oauth(&app3, p3, s3, f3, m3, &full).await;
        });
        false
    })
    .build()
    .map_err(|e| {
        let mut pending = pending_oauth_guard();
        if pending.as_ref().map(|p| p.flow == flow).unwrap_or(false) {
            *pending = None;
        }
        let m = i18n::trf("err.oauth.window", &[("e", &e.to_string())]);
        flowlog::log(&flow, "window-fail", &m);
        m
    })?;
    if let Some(w) = app.get_webview_window("login") {
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::CloseRequested { .. } = e {
                let mut pending = pending_oauth_guard();
                if pending.as_ref().map(|p| p.flow == flow_close).unwrap_or(false) {
                    flowlog::log(&flow_close, "cancelled", "");
                    *pending = None;
                }
            }
        });
    }
    spawn_poll_loop(app.clone(), provider.clone(), flow.clone(), mid, poll_cfg);
    Ok(json!({ "opened": true, "provider": provider }))
}

fn sweep_login_profiles(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 3600);
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() && meta.modified().map(|m| m < cutoff).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[tauri::command]
fn oauth_cancel() -> Result<(), String> {
    // 浏览器登录弹窗的取消：清 pending 即可，poll 线程下一轮发现 flow 失效自行退出
    let mut pending = pending_oauth_guard();
    if let Some(p) = pending.take() {
        flowlog::log(&p.flow, "cancelled", "browser-cancel");
    }
    Ok(())
}

#[tauri::command]
async fn set_account_order(ids: Vec<String>) -> Result<(), String> {
    let _guard = store_guard();
    let paths = Paths::detect();
    // id 仅用于排序匹配，走与 load_account 相同的白名单字符校验，拒收脏数据
    let cleaned: Vec<String> = ids
        .into_iter()
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .take(1024)
        .collect();
    let mut st = load_settings(&paths);
    st.account_order = Some(cleaned);
    save_settings(&paths, &st)?;
    Ok(())
}

#[tauri::command]
async fn set_auth_proxy(app: AppHandle, on: bool, url: Option<String>) -> Result<(), String> {
    {
        let _guard = store_guard();
        let paths = Paths::detect();
        let trimmed = url.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let normalized = match trimmed {
            Some(s) => Some(oauth::parse_proxy_url(s)?),
            None => None,
        };
        if on && normalized.is_none() {
            return Err(i18n::tr("err.proxy.need_url"));
        }
        let mut s = load_settings(&paths);
        s.auth_proxy_on = Some(on);
        s.auth_proxy_url = normalized;
        save_settings(&paths, &s)?;
    }
    let _ = app.emit("state-changed", ());
    Ok(())
}

async fn finish_oauth(app: &AppHandle, provider: String, state: String, flow: String, mid: String, callback_url: &str) {
    let result = {
        let provider = provider.clone();
        let state = state.clone();
        let flow = flow.clone();
        let mid = mid.clone();
        let callback_url = callback_url.to_string();
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            {
                let pending = pending_oauth_guard();
                match pending.as_ref() {
                    Some(p) if p.provider == provider && p.state == state && p.flow == flow => {}
                    Some(_) | None => {
                        flowlog::log(&flow, "deeplink-superseded", "");
                        return Err("__superseded__".into());
                    }
                }
            }
            let (code, cb_state) = match oauth::parse_callback(&callback_url) {
                Ok(oauth::CallbackKind::Code { code, state }) => (code, state),
                Ok(oauth::CallbackKind::Attribution) => {
                    flowlog::log(&flow, "deeplink-attribution", "");
                    return Err("__attribution__".into());
                }
                Err(e) => {
                    flowlog::log(&flow, "deeplink-parse-fail", &e);
                    return Err(e);
                }
            };
            if cb_state != state {
                flowlog::log(&flow, "deeplink-state-mismatch", "");
                return Err(i18n::tr("err.oauth.state"));
            }
            let exchanged = match oauth::exchange_token(&provider, &code, &state, &mid) {
                Ok(v) => v,
                Err(e) => {
                    flowlog::log(&flow, "exchange-fail", &e);
                    return Err(e);
                }
            };
            match persist_oauth_account(&Paths::detect(), &provider, &exchanged["raw"], &flow, &mid, false) {
                Ok(v) => {
                    flowlog::log(
                        &flow,
                        "persist-ok",
                        &format!("channel=deeplink duplicate={}", v.get("duplicate").is_some()),
                    );
                    Ok(v)
                }
                Err(e) => {
                    if e != "__superseded__" {
                        flowlog::log(&flow, "persist-fail", &format!("channel=deeplink {e}"));
                    }
                    Err(e)
                }
            }
        })
        .await
        .unwrap_or_else(|e| Err(i18n::trf("err.oauth.flow", &[("e", &e.to_string())])))
    };
    if let Err(e) = &result {
        if deeplink_err_soft(e) {
            let ours = pending_oauth_guard().as_ref().map(|p| p.flow == flow).unwrap_or(false);
            if ours {
                flowlog::log(&flow, "soft-fail", e);
                let _ = app.emit("oauth://done", &json!({ "ok": false, "soft": true, "error": e }));
            }
            return;
        }
    }
    finalize_oauth_result(app, result);
}

fn deeplink_err_soft(e: &str) -> bool {
    e != "__superseded__" && e != "__attribution__"
}

fn persist_oauth_account(
    paths: &Paths,
    provider: &str,
    raw: &serde_json::Value,
    flow: &str,
    mid: &str,
    poll_ready: bool,
) -> Result<serde_json::Value, String> {
    let flow_still_ours = || {
        pending_oauth_guard()
            .as_ref()
            .map(|p| p.flow == flow)
            .unwrap_or(false)
    };
    if !flow_still_ours() {
        return Err("__superseded__".into());
    }
    let jwt = raw
        .pointer("/data/token")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| i18n::tr("err.oauth.no_token"))?
        .to_string();
    let raw_access = oauth::extract_access_token(provider, raw).unwrap_or_default();
    let access_token = if provider == "zai" && !raw_access.is_empty() {
        oauth::resolve_zai_business_token(&raw_access).ok_or_else(|| i18n::tr("err.oauth.zai_business"))?
    } else {
        raw_access
    };
    let userinfo = if poll_ready {
        oauth::extract_poll_user_profile(raw)
    } else {
        oauth::extract_user_profile(provider, raw)
    }
    .or_else(|| {
        (!access_token.is_empty())
            .then(|| oauth::fetch_userinfo(provider, &access_token))
            .flatten()
    });
    let refresh_token = oauth::extract_refresh_token(provider, raw);
    let credentials = oauth::assemble_credentials_with_token(
        provider,
        &jwt,
        userinfo.as_ref(),
        (!access_token.is_empty()).then_some(access_token.as_str()),
        refresh_token.as_deref(),
    );
    let config = oauth::assemble_config(provider, &jwt, &access_token);

    let _lock = store_guard();
    if !flow_still_ours() {
        return Err("__superseded__".into());
    }
    let accounts = list_accounts(paths)?;
    let hash = canonical_hash(&credentials);
    if let Some(i) = store::find_same_login(&credentials, &hash, &accounts, &paths.home) {
        let mut dup = accounts[i].clone();
        dup.hash = hash.clone();
        dup.credentials = credentials;
        dup.config = Some(config);
        dup.updated_at = now_ts();
        if dup.virtual_device_mid.as_deref().map_or(true, |m| m.trim().is_empty()) {
            dup.virtual_device_mid = Some(mid.to_string());
        }
        if !flow_still_ours() {
            return Err("__superseded__".into());
        }
        save_account(paths, &dup)?;
        *pending_oauth_guard() = None;
        return Ok(json!({ "id": dup.id, "name": dup.name, "provider": provider, "duplicate": true }));
    }
    let base = credentials
        .get(format!("oauth:{provider}:user_info"))
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|u| u.get("username").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_else(|| match provider {
            "zai" => "z.ai".to_string(),
            _ => "BigModel".to_string(),
        });
    let name = unique_name(&accounts, &base);
    let ts = now_ts();
    let acc = Account {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.clone(),
        created_at: ts.clone(),
        updated_at: ts,
        hash,
        credentials,
        config: Some(config),
        virtual_device_mid: Some(mid.to_string()),
        virtual_arms_uid: Some(store::new_arms_uid()),
    };
    if !flow_still_ours() {
        return Err("__superseded__".into());
    }
    save_account(paths, &acc)?;
    *pending_oauth_guard() = None;
    Ok(json!({ "id": acc.id, "name": acc.name, "provider": provider }))
}

fn finalize_oauth_result(app: &AppHandle, result: Result<serde_json::Value, String>) {
    if let Err(e) = &result {
        if e == "__superseded__" || e == "__attribution__" {
            return;
        }
    }
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.close();
    }
    let payload = match result {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = app.emit("oauth://done", &payload);
}

fn spawn_poll_loop(app: AppHandle, provider: String, flow: String, mid: String, cfg: PollCfg) {
    std::thread::spawn(move || {
        let ours = || pending_oauth_guard().as_ref().map(|p| p.flow == flow).unwrap_or(false);
        let deadline = {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            std::cmp::min(cfg.expires_at_ms, now + u128::from(oauth::FLOW_TIMEOUT_MS))
        };
        loop {
            if !ours() {
                flowlog::log(&flow, "poll-exit", "flow-done-or-replaced");
                return;
            }
            match oauth::poll_flow_once(&cfg.url, &cfg.token, &mid) {
                Ok(oauth::PollOutcome::Pending) => {}
                Ok(oauth::PollOutcome::Ready(data)) => {
                    flowlog::log(&flow, "poll-ready", "");
                    let raw = json!({ "code": 0, "data": data });
                    let result = persist_oauth_account(&Paths::detect(), &provider, &raw, &flow, &mid, true);
                    match &result {
                        Ok(v) => flowlog::log(
                            &flow,
                            "persist-ok",
                            &format!("channel=poll duplicate={}", v.get("duplicate").is_some()),
                        ),
                        Err(e) if e != "__superseded__" => {
                            flowlog::log(&flow, "persist-fail", &format!("channel=poll {e}"));
                        }
                        Err(_) => {}
                    }
                    finalize_oauth_result(&app, result);
                    return;
                }
                Err(e) => {
                    if !ours() {
                        flowlog::log(&flow, "poll-exit", "superseded");
                        return;
                    }
                    flowlog::log(&flow, "poll-fail", &e);
                    *pending_oauth_guard() = None;
                    finalize_oauth_result(&app, Err(e));
                    return;
                }
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            if now >= deadline {
                if !ours() {
                    return;
                }
                flowlog::log(&flow, "poll-timeout", "");
                *pending_oauth_guard() = None;
                finalize_oauth_result(&app, Err(i18n::tr("err.oauth.expired")));
                return;
            }
            let sleep = (deadline - now).min(cfg.interval_ms as u128) as u64;
            std::thread::sleep(std::time::Duration::from_millis(sleep));
        }
    });
}

/// 验证码窗口关窗代次：`close_captcha_window` 延迟销毁期间若有新窗打开/复用，
/// 旧定时器不得误杀新窗。
static CAPTCHA_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn open_captcha_window(app: &AppHandle, auto: bool) -> Result<(), String> {
    let (w, h) = (380.0, 320.0);
    // 无痕失败是否重试由页面自己判（auto = 隐藏窗，重试用户无感知），模式随 URL 走；
    // 复用已有窗口时不能 reload——reload 会带上一次的 query，手动转 auto 会丢掉重试能力
    let page = if auto { "captcha.html?auto=1" } else { "captcha.html" };
    // 开窗即作废上一轮延迟销毁（复用路径也要 bump：否则在飞的定时器会关掉刚复用的窗）
    CAPTCHA_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("captcha") {
        let _ = win.eval(&format!("location.replace({page:?})"));
        center_over_main(app, &win, w, h);
        if auto {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "captcha",
        tauri::WebviewUrl::App(page.into()),
    )
    .title(i18n::tr("title.captcha"))
    .theme(Some(tauri::Theme::Dark))
    .background_color(tauri::window::Color(10, 10, 12, 255))
    .inner_size(w, h)
    .min_inner_size(340.0, 280.0)
    .maximizable(false)
    .resizable(false)
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI --no-proxy-server")
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    center_over_main(app, &win, w, h);
    if !auto {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn kill_zcode(app: AppHandle) -> Result<(), String> {
    let _guard = store_guard();
    let r = if store::kill_zcode()? { Ok(()) } else { Err(i18n::tr("err.zcode.kill_timeout")) };
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn set_behavior(
    app: AppHandle,
    launch_after_switch: Option<bool>,
    close_to_tray: Option<bool>,
    hot_switch: Option<bool>,
    auto_claim: Option<bool>,
) -> Result<(), String> {
    let _guard = store_guard();
    let paths = Paths::detect();
    let mut s = load_settings(&paths);
    if let Some(v) = launch_after_switch {
        s.launch_after_switch = Some(v);
    }
    if let Some(v) = close_to_tray {
        s.close_to_tray = Some(v);
    }
    if let Some(v) = hot_switch {
        s.hot_switch = Some(v);
    }
    if let Some(v) = auto_claim {
        s.auto_claim = Some(v);
    }
    let r = save_settings(&paths, &s);
    rebuild_tray(&app);
    let _ = app.emit("state-changed", ());
    r
}

#[tauri::command]
async fn set_language(app: AppHandle, lang: String) -> Result<(), String> {
    let l = i18n::Lang::parse(&lang)
        .ok_or_else(|| i18n::trf("err.lang.unknown", &[("lang", &lang)]))?;
    {
        let _guard = store_guard();
        let paths = Paths::detect();
        let mut s = load_settings(&paths);
        s.language = Some(l.as_str().to_string());
        save_settings(&paths, &s)?;
    }
    i18n::set(l);
    rebuild_tray(&app);
    for (label, key) in [("captcha", "title.captcha"), ("login", "title.login")] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_title(&i18n::tr(key));
        }
    }
    // 不广播 state-changed：语言是前端本地可知的单一字段，
    // 广播只会让设置页白跑一轮 get_state 全量账号扫描
    Ok(())
}

#[tauri::command]
async fn reveal_main(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or_else(|| i18n::tr("err.main.missing"))?;
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

fn center_over_main(app: &AppHandle, win: &tauri::WebviewWindow, w: f64, h: f64) {
    let Some(m) = app.get_webview_window("main") else { return };
    let (Ok(p), Ok(s), Ok(scale)) = (m.outer_position(), m.outer_size(), m.scale_factor()) else { return };
    let (mx, my) = (p.x as f64 / scale, p.y as f64 / scale);
    let (mw, mh) = (s.width as f64 / scale, s.height as f64 / scale);
    let x = mx + (mw - w).max(0.0) / 2.0;
    let y = my + (mh - h).max(0.0) / 2.0;
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

#[tauri::command]
async fn autostart_status(app: AppHandle) -> Result<bool, String> {
    let al = app.state::<AutoLaunchManager>();
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn autostart_set(app: AppHandle, enable: bool) -> Result<bool, String> {
    let al = app.state::<AutoLaunchManager>();
    if enable {
        al.enable().map_err(|e| e.to_string())?;
    } else {
        al.disable().map_err(|e| e.to_string())?;
    }
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_pick_path(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let acc = load_account(&Paths::detect(), &id)?;
    let default_name = format!("{}.zsb", sanitize_filename(&acc.name));
    let picked = app
        .dialog()
        .file()
        .add_filter(&i18n::tr("dialog.zsb"), &["zsb"])
        .set_file_name(&default_name)
        .blocking_save_file();
    let Some(fp) = picked else {
        return Ok(json!({ "picked": false }));
    };
    let path = fp.into_path().map_err(|e| i18n::trf("err.path.invalid", &[("e", &e.to_string())]))?;
    Ok(json!({ "picked": true, "path": path.to_string_lossy(), "name": acc.name }))
}

#[tauri::command]
async fn export_finalize(path: String, id: String, password: String) -> Result<serde_json::Value, String> {
    let acc = load_account(&Paths::detect(), &id)?;
    let payload = store::export_bundle_value(std::slice::from_ref(&acc));
    let sealed = cipher::seal(&payload, &password, cipher::FORMAT_BUNDLE)?;
    let body = serde_json::to_string_pretty(&sealed).unwrap() + "\n";
    store::atomic_write(std::path::Path::new(&path), &body).map_err(|e| i18n::trf("err.write", &[("e", &e.to_string())]))?;
    Ok(json!({ "saved": true, "path": path }))
}

#[tauri::command]
async fn export_all_pick_path(app: AppHandle) -> Result<serde_json::Value, String> {
    let accounts = list_accounts(&Paths::detect())?;
    if accounts.is_empty() {
        return Err(i18n::tr("err.export.empty"));
    }
    let picked = app
        .dialog()
        .file()
        .add_filter(&i18n::tr("dialog.zsb"), &["zsb"])
        .set_file_name("zcode-accounts.zsb")
        .blocking_save_file();
    let Some(fp) = picked else {
        return Ok(json!({ "picked": false }));
    };
    let path = fp.into_path().map_err(|e| i18n::trf("err.path.invalid", &[("e", &e.to_string())]))?;
    Ok(json!({ "picked": true, "path": path.to_string_lossy(), "count": accounts.len() }))
}

#[tauri::command]
async fn export_all_finalize(path: String, password: String) -> Result<serde_json::Value, String> {
    let accounts = list_accounts(&Paths::detect())?;
    if accounts.is_empty() {
        return Err(i18n::tr("err.export.empty_short"));
    }
    let payload = store::export_bundle_value(&accounts);
    let sealed = cipher::seal(&payload, &password, cipher::FORMAT_BUNDLE)?;
    let body = serde_json::to_string_pretty(&sealed).unwrap() + "\n";
    store::atomic_write(std::path::Path::new(&path), &body).map_err(|e| i18n::trf("err.write", &[("e", &e.to_string())]))?;
    Ok(json!({ "saved": true, "path": path, "count": accounts.len() }))
}

#[tauri::command]
async fn import_pick_files(app: AppHandle) -> Result<serde_json::Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(&i18n::tr("dialog.zsb"), &["zsb"])
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(json!({ "picked": false }));
    };
    let mut sealed = vec![];
    let mut errors = vec![];
    for fp in files {
        let path = match fp.into_path() {
            Ok(p) => p,
            Err(e) => {
                errors.push(i18n::trf("err.path.conv", &[("e", &e.to_string())]));
                continue;
            }
        };
        let fname = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) => {
                errors.push(i18n::trf("err.import.read", &[("fname", fname.as_str()), ("e", &e.to_string())]));
                continue;
            }
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(v) => {
                if !cipher::is_sealed(&v) {
                    errors.push(i18n::trf("err.import.not_sealed", &[("fname", fname.as_str())]));
                } else if v.get("format").and_then(|f| f.as_str()) != Some(cipher::FORMAT_BUNDLE) {
                    errors.push(i18n::trf("err.import.not_bundle", &[("fname", fname.as_str())]));
                } else {
                    sealed.push((fname, v));
                }
            }
            Err(e) => errors.push(i18n::trf("err.import.json", &[("fname", fname.as_str()), ("e", &e.to_string())])),
        }
    }
    Ok(json!({ "picked": true, "sealed": sealed, "errors": errors }))
}

#[tauri::command]
async fn import_sealed(app: AppHandle, files: Vec<(String, Value)>, password: String) -> Result<ImportReport, String> {
    let _guard = store_guard();
    let mut decrypted = vec![];
    let mut errors = vec![];
    for (fname, v) in files {
        match cipher::open(&v, &password) {
            Ok(payload) => decrypted.push((fname, payload)),
            Err(e) => errors.push(i18n::trf("err.import.wrap", &[("fname", fname.as_str()), ("e", &e)])),
        }
    }
    let mut report = if decrypted.is_empty() {
        ImportReport::default()
    } else {
        import_values(&Paths::detect(), &decrypted)?
    };
    report.picked = true;
    report.errors.extend(errors);
    rebuild_tray(&app);
    Ok(report)
}

#[tauri::command]
async fn pick_zcode_path(app: AppHandle) -> Result<serde_json::Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter(&i18n::tr("dialog.exe"), &["exe"])
        .blocking_pick_file();
    let Some(fp) = picked else {
        return Ok(json!({ "picked": false }));
    };
    let path = fp.into_path().map_err(|e| i18n::trf("err.path.invalid", &[("e", &e.to_string())]))?;
    Ok(json!({ "picked": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
async fn set_zcode_path(app: AppHandle, path: String) -> Result<(), String> {
    let _guard = store_guard();
    let paths = Paths::detect();
    let mut s = load_settings(&paths);
    s.zcode_path = store::normalize_zcode_path(&path);
    let r = save_settings(&paths, &s);
    rebuild_tray(&app);
    let _ = app.emit("state-changed", ());
    r
}

#[tauri::command]
async fn launch_zcode(app: AppHandle) -> Result<(), String> {
    let paths = Paths::detect();
    let (p, ok) = effective_zcode_path(&paths);
    if !ok {
        return Err(i18n::trf("err.zcode.path_invalid_hint", &[("p", &p)]));
    }
    let r = store::launch_zcode(&p);
    rebuild_tray(&app);
    r
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    store::open_url(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(gateway::GatewayState::new())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(gated_handler(tauri::generate_handler![
            get_state,
            app_version,
            capture_current,
            rename_account,
            delete_account,
            update_account_from_live,
            switch_to,
            get_live_quota,
            get_account_quota,
            claim_refresh_one,
            claim_pending_check,
            claim_start,
            claim_captcha_config,
            claim_captcha_submit,
            claim_cancel,
            referral_summary,
            referral_invitees,
            referral_bind_start,
            referral_bind_cancel,
            oauth_providers,
            oauth_begin,
            oauth_cancel,
            set_account_order,
            set_auth_proxy,
            kill_zcode,
            set_behavior,
            set_language,
            autostart_status,
            autostart_set,
            export_pick_path,
            export_finalize,
            export_all_pick_path,
            export_all_finalize,
            import_pick_files,
            import_sealed,
            pick_zcode_path,
            set_zcode_path,
            launch_zcode,
            open_external,
            reveal_main,
            gateway_start,
            gateway_stop,
            gateway_status,
            provider_fetch_models,
            provider_test,
            gateway_log_history,
        ]))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let paths = Paths::detect();
                    if store::load_settings(&paths).close_to_tray() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                if window.label() == "captcha" {
                    *pending_guard() = None;
                    *pending_bind_guard() = None;
                    // 用户手动关窗：让前端的 claim/bind waiter 立即结束，不等 90s 超时
                    let _ = window.app_handle().emit("captcha://closed", ());
                }
            }
        })
        .setup(|app| {
            i18n::init_from_settings(&store::load_settings(&Paths::detect()));
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                flowlog::init(&data_dir);
            }
            // 应用内更新：endpoint 与公钥在 tauri.conf.json plugins.updater
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("no window icon").clone())
                .tooltip("Z·SWITCH")
                .menu(&tray_menu_inner(app.handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    match id.as_str() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        other => run_tray_action(app.clone(), other.to_string()),
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 网关自启恢复：上次退出时服务在跑就自动拉起（dev 重编重启同理）。
            // 端口被占时后台线程绑定失败只打日志，running 标志照旧置位——既有瑕疵，不在此扩修
            {
                let gw = app.state::<gateway::GatewayState>();
                let want = gw.config.lock().map(|c| c.auto_start).unwrap_or(false);
                if want {
                    if let Err(e) = gw.start() {
                        eprintln!("[gateway] 自启恢复失败: {e}");
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---- GATEWAY IPC 命令（M1） ----

#[tauri::command]
async fn gateway_start(
    app: tauri::AppHandle,
    port: Option<u16>,
    api_key: Option<String>,
    upstream_connect_secs: Option<u64>,
    max_retries: Option<u32>,
    global_backoff_secs: Option<u64>,
    sticky: Option<bool>,
    allowed_fails: Option<u32>,
    keepalive_secs: Option<u64>,
    total_timeout_secs: Option<u64>,
    cors_origins: Option<Vec<String>>,
    body_limit_mb: Option<u64>,
    log_to_disk: Option<bool>,
    log_file_max_mb: Option<u64>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<gateway::GatewayState>();
    // 配置更新：只在提供字段时改写（表单保存语义）
    {
        let mut cfg = state.config.lock().map_err(|e| e.to_string())?;
        if let Some(p) = port { cfg.port = p; }
        if let Some(k) = api_key { if !k.trim().is_empty() { cfg.api_key = k.trim().to_string(); } }
        if let Some(v) = upstream_connect_secs { if v > 0 { cfg.upstream_connect_secs = v; } }
        if let Some(v) = max_retries { cfg.max_retries = v; }
        if let Some(v) = global_backoff_secs { cfg.global_backoff_secs = v; }
        if let Some(v) = sticky { cfg.sticky = v; }
        if let Some(v) = allowed_fails { cfg.allowed_fails = v; }
        if let Some(v) = keepalive_secs { cfg.keepalive_secs = v.min(300); }
        if let Some(v) = total_timeout_secs { cfg.total_timeout_secs = v.min(3600); }
        if let Some(v) = cors_origins { cfg.cors_origins = v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(); }
        if let Some(v) = body_limit_mb { if v > 0 && v <= 512 { cfg.body_limit_mb = v; } }
        if let Some(v) = log_to_disk { cfg.log_to_disk = v; }
        if let Some(v) = log_file_max_mb { if v > 0 && v <= 1024 { cfg.log_file_max_mb = v; } }
        // 落盘：不保存的话新端口/密钥重启即丢，UI 上的「保存」就成了骗局
        if let Err(e) = cfg.save() {
            eprintln!("[gateway] 配置落盘失败: {e}");
        }
    }
    let started = state.start()?;
    Ok(json!({ "running": state.is_running(), "started": started }))
}

#[tauri::command]
async fn gateway_stop(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<gateway::GatewayState>();
    let stopped = state.stop()?;
    Ok(json!({ "running": state.is_running(), "stopped": stopped }))
}

#[tauri::command]
async fn gateway_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<gateway::GatewayState>();
    let cfg = state.config.lock().map_err(|e| e.to_string())?.clone();
    // pool 快照：成员清单现取（账号库投影），池侧只回冷却/在飞/计数
    let members = gateway::pool::members().unwrap_or_default();
    let mut snapshot = state.shared.pool.snapshot(&members);
    // 每号模型面拼进成员（server.rs ensure_model_faces 回写镜像）：null=未知，[]=确认无桶
    if let Some(arr) = snapshot.get_mut("members").and_then(serde_json::Value::as_array_mut) {
        let faces = state.shared.model_faces();
        for m in arr.iter_mut() {
            let id = match m.get("id").and_then(serde_json::Value::as_str) {
                Some(id) => id.to_string(),
                None => continue,
            };
            m["models"] = match faces.get(&id) {
                Some(Some(list)) => json!(list),
                Some(None) => json!([]),
                None => serde_json::Value::Null,
            };
        }
    }
    Ok(json!({
        "running": state.is_running(),
        "port": cfg.port,
        // 密钥明文回前端：本机 UI 是唯一操作者，密钥本来就是要填进第三方客户端的，藏起来只有掩码没有意义
        "apiKey": cfg.api_key,
        "apiKeyMasked": if cfg.api_key.len() > 8 {
            format!("{}…{}", &cfg.api_key[..6], &cfg.api_key[cfg.api_key.len()-4..])
        } else { "***".to_string() },
        "hasApiKey": !cfg.api_key.is_empty(),
        // 自启恢复标志（启动时是否自动拉起服务）
        "autoStart": cfg.auto_start,
        // M5 扩展：池快照 + 请求日志环
        "pool": snapshot,
        "logs": state.shared.logs(),
        // 模型表与 /v1/models 同源：动态模型面（聚合成功后 shared.models 被覆盖），
        // 未聚合时回落静态 MODEL_LIST 初始值
        "models": state.shared.model_list(),
        // 配置面回显（调优输入框的初值）
        "upstreamConnectSecs": cfg.upstream_connect_secs,
        "maxRetries": cfg.max_retries,
        "sticky": cfg.sticky,
        "globalBackoffSecs": cfg.global_backoff_secs,
        "allowedFails": cfg.allowed_fails,
        "keepaliveSecs": cfg.keepalive_secs,
        "totalTimeoutSecs": cfg.total_timeout_secs,
        "corsOrigins": cfg.cors_origins,
        "bodyLimitMb": cfg.body_limit_mb,
        "logToDisk": cfg.log_to_disk,
        "logFileMaxMb": cfg.log_file_max_mb,
    }))
}

/// 供应商页动作（magpie 式）：获取模型——有 key 拉 /v1/models，无 key 回缓存
#[tauri::command]
async fn provider_fetch_models(provider_id: String) -> Result<serde_json::Value, String> {
    gateway::provider::fetch_models(&provider_id).await
}

/// 供应商页动作：右键测试——tiny 请求（8 token），返回 {ok, status, ms, error, model}；
/// zcode 上游可指定账号单测（account_id），测试完全绕开池轮转/熔断
#[tauri::command]
async fn provider_test(
    provider_id: String,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    gateway::provider::test_provider(&provider_id, account_id).await
}

/// 日志历史：读 gateway.jsonl 尾部（独立日志页用，全量而非内存环 200 条）
#[tauri::command]
async fn gateway_log_history() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(|| {
        use std::io::{BufRead, Seek, SeekFrom};
        let p = crate::Paths::detect().store_dir().join("gateway.jsonl");
        // 从未发过请求时文件不存在：返回空列表而非报错
        let f = match std::fs::File::open(&p) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let mut rd = std::io::BufReader::new(f);
        // 尾部读取：先定位文件尾，再从后往前收集最多 2000 行
        let len = rd.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        let start = len.saturating_sub(512 * 1024);
        rd.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut lines = Vec::new();
        let mut buf = String::new();
        // 起点在行中间时先丢弃半行
        if start > 0 {
            let _ = rd.read_line(&mut buf);
            buf.clear();
        }
        loop {
            buf.clear();
            let n = rd.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            lines.push(buf.clone());
            if lines.len() > 4000 { lines.drain(0..lines.len() - 4000); }
        }
        Ok(lines.into_iter().filter_map(|l| serde_json::from_str(&l).ok()).collect::<Vec<_>>())
    }).await.map_err(|e| e.to_string())?
}
