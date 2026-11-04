fn main() {
    // 静态链接 VC 运行库：CLI schema（2.11.4）不认 build.windows.staticVCRuntime
    // （config.schema.json 无此键，tauri.conf.json 写了直接 Additional properties 拒绝），
    // 走 WindowsAttributes 通道（tauri-build 2.7.4 should_static_link_vc_runtime 的合法路径）
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().static_vc_runtime(true),
        ),
    )
    .expect("failed to run tauri-build");
}
