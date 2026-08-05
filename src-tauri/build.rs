fn main() {
    // 注意：tauri-build 不监听 icons/ 目录变化，更换图标后需改动本文件
    // 触发 build.rs 重跑，否则 exe 内嵌图标不会更新（窗口图标不受影响）。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
