use crate::platform::Emitter;
fn merge_settings_for_save(
    mut incoming: crate::settings::AppSettings,
    existing: &crate::settings::AppSettings,
) -> crate::settings::AppSettings {
    match (&mut incoming.webdav_sync, &existing.webdav_sync) {
        // incoming 没有 webdav → 保留现有
        (None, _) => {
            incoming.webdav_sync = existing.webdav_sync.clone();
        }
        // incoming 有 webdav 但密码为空，且现有有密码 → 填回现有密码
        // （get_settings_for_frontend 总是清空密码，所以通过 save_settings
        //   传入的空密码意味着"保持现有"而非"用户主动清空"）
        (Some(incoming_sync), Some(existing_sync))
            if incoming_sync.password.is_empty() && !existing_sync.password.is_empty() =>
        {
            incoming_sync.password = existing_sync.password.clone();
        }
        _ => {}
    }
    match (&mut incoming.s3_sync, &existing.s3_sync) {
        // incoming 没有 s3 → 保留现有
        (None, _) => {
            incoming.s3_sync = existing.s3_sync.clone();
        }
        // incoming 有 s3 但密钥为空，且现有有密钥 → 填回现有密钥
        (Some(incoming_sync), Some(existing_sync))
            if incoming_sync.secret_access_key.is_empty()
                && !existing_sync.secret_access_key.is_empty() =>
        {
            incoming_sync.secret_access_key = existing_sync.secret_access_key.clone();
        }
        _ => {}
    }
    // local_migrations 是纯后端状态（迁移完成标记），前端没有合法的修改场景，
    // 无条件取现有值。若按 incoming 透传：后端清掉 marker（如关闭统一会话
    // 开关）后、前端 query 缓存刷新前的一次全量保存会把旧 marker 重放回来，
    // 重新开启时被"复活"的标记挡住而漏迁。
    incoming.local_migrations = existing.local_migrations.clone();
    // 客户端地址只经 set_proxy_client_host 保存（它还要重写客户端）；全量保存带的是前端
    // 缓存里的旧值，透传会把刚保存的地址冲掉。
    incoming.proxy_client_host = existing.proxy_client_host.clone();
    // 轻量模式状态只由进入 / 退出轻量模式时写，前端缓存里的值总是旧的。
    incoming.lightweight_mode = existing.lightweight_mode;
    incoming
}

pub async fn get_settings() -> Result<crate::settings::AppSettings, String> {
    Ok(crate::settings::get_settings_for_frontend())
}

pub async fn save_settings(
    app: crate::platform::AppHandle,
    state: crate::platform::State<crate::store::AppState>,
    settings: crate::settings::AppSettings,
) -> Result<bool, String> {
    let existing = crate::settings::get_settings();
    if settings.unify_codex_migrate_existing == Some(true) && existing.unify_codex_migrate_existing != Some(true) {
        return Err("现有会话迁移需要修改 Codex 私有 SQLite，目录授权不能安全执行；请在 Codex 中管理现有会话".into());
    }
    let merged = merge_settings_for_save(settings, &existing);
    let unify_codex_changed =
        merged.unify_codex_session_history != existing.unify_codex_session_history;
    let unify_codex_enabled = merged.unify_codex_session_history;
    // 经典子 agent 开关、聚合子 agent 模型/强度和聚合自动审批模型都只影响 Stack 模式下
    // 写给 Codex 的内容。
    let stack_settings_changed = merged.codex_stack_classic_tools
        != existing.codex_stack_classic_tools
        || merged.codex_stack_subagent_model != existing.codex_stack_subagent_model
        || merged.codex_stack_subagent_reasoning_effort
            != existing.codex_stack_subagent_reasoning_effort
        || merged.codex_stack_auto_review_model != existing.codex_stack_auto_review_model;
    let tray_style_changed = merged.native_tray_menu != existing.native_tray_menu;
    let auto_update_disabled = existing.auto_update_enabled && !merged.auto_update_enabled;
    let without_login_changed =
        merged.codex_proxy_without_official_login != existing.codex_proxy_without_official_login;
    let preserve_login_changed = merged.preserve_codex_official_auth_on_switch
        != existing.preserve_codex_official_auth_on_switch;
    crate::settings::update_settings(merged)?;

    // 原生托盘菜单 / 托盘面板当场切换，不用重启。
    let _ = tray_style_changed;

    // 关闭自动更新时立即释放内存里已下载的安装包字节，避免几十 MB 常驻进程。
    let _ = auto_update_disabled;

    // 立即重写，失败时回滚设置，免得界面显示已改好、客户端还是旧的。
    if stack_settings_changed {
        if let Err(err) = crate::mode::controller::resync_codex_stack_catalog(state.inner()).await {
            log::warn!("Codex 聚合设置变更后重写客户端配置失败，回滚设置: {err}");
            let mut rollback = crate::settings::get_settings();
            rollback.codex_stack_classic_tools = existing.codex_stack_classic_tools;
            rollback.codex_stack_subagent_model = existing.codex_stack_subagent_model.clone();
            rollback.codex_stack_subagent_reasoning_effort =
                existing.codex_stack_subagent_reasoning_effort.clone();
            rollback.codex_stack_auto_review_model = existing.codex_stack_auto_review_model.clone();
            if let Err(rollback_err) = crate::settings::update_settings(rollback) {
                log::error!("回滚 Codex 聚合设置失败: {rollback_err}");
            }
            return Err(format!(
                "聚合设置未生效（Codex 配置重写失败） (The aggregation setting did not take effect: rewriting the Codex config failed): {err}"
            ));
        }
    }

    // 「暂停使用官方登录」只影响路由 / 聚合模式下写给 Codex 的内容：立即重写，失败回滚。
    if without_login_changed {
        if let Err(err) = crate::mode::controller::resync_codex_proxy(state.inner()).await {
            log::warn!("「暂停使用官方登录」变更后重写 Codex 配置失败，回滚设置: {err}");
            let mut rollback = crate::settings::get_settings();
            rollback.codex_proxy_without_official_login =
                existing.codex_proxy_without_official_login;
            if let Err(rollback_err) = crate::settings::update_settings(rollback) {
                log::error!("回滚「暂停使用官方登录」设置失败: {rollback_err}");
            }
            return Err(format!(
                "「暂停使用官方登录」未生效（Codex 配置重写失败） (\"Pause the official login\" did not take effect: rewriting the Codex config failed): {err}"
            ));
        }
    }

    // 「非接管切换时保留官方登录」只影响直连切到第三方：当前就是直连第三方时立即重写，
    // 不必先切回官方卡再切回来；失败回滚。
    if preserve_login_changed {
        if let Err(err) =
            crate::services::provider::reapply_current_codex_third_party_live(state.inner())
        {
            log::warn!("「非接管切换时保留官方登录」变更后重写 Codex 配置失败，回滚设置: {err}");
            let mut rollback = crate::settings::get_settings();
            rollback.preserve_codex_official_auth_on_switch =
                existing.preserve_codex_official_auth_on_switch;
            if let Err(rollback_err) = crate::settings::update_settings(rollback) {
                log::error!("回滚「非接管切换时保留官方登录」设置失败: {rollback_err}");
            }
            return Err(format!(
                "「非接管切换时保留官方登录」未生效（Codex 配置重写失败） (\"Keep official login for direct switches\" did not take effect: rewriting the Codex config failed): {err}"
            ));
        }
    }

    // 统一会话开关变更时立即重写当前官方 Codex 供应商的 live 配置，
    // 不必等下一次切换才生效。
    if unify_codex_changed {
        // live 重写失败时回滚设置并把保存整体报失败：若设置保持已切换状态，
        // live 仍跑旧桶，后续的历史迁移/还原会让会话再次分裂（开启=历史
        // 迁走而新会话仍写 openai 桶；关闭=会话还原而 live 仍写 custom）。
        // 报错让前端 saved=false 短路还原；回滚是整次保存的事务语义
        // （本开关的保存只携带开关相关字段）。
        if let Err(err) =
            crate::services::provider::reapply_current_codex_official_live(state.inner())
        {
            log::warn!("统一 Codex 会话历史开关变更后重写 live 配置失败，回滚设置: {err}");
            if let Err(rollback_err) = crate::settings::update_settings(existing) {
                log::error!("回滚统一会话开关设置失败: {rollback_err}");
            }
            return Err(format!(
                "统一 Codex 会话历史开关未生效（live 配置重写失败）: {err}"
            ));
        }

        let _ = unify_codex_enabled;
    }

    Ok(true)
}
