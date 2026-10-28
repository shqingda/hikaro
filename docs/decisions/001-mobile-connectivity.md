# ADR-001：优先 Cloudflare 中转，暂缓 Tailscale

## 状态

Accepted · 2026-10-29。接受的是实施优先级，不代表能力已经完成或大陆网络已经验收。Tailscale 保留为备选，待用户明确恢复后再实施。

## 2026-10-29 实施更新

用户明确取消网络稳定性预验证，要求直接实施；不再把大陆网络测试作为开工或部署前置。已实现默认服务地址、公开宿主注册、六位码交换、手机自持私钥及双端指纹确认、局域网直连和中转回退。验证与部署记录见[本轮交付](../validation/pairing-20261029.md)。下文的“现状”和顺序保留决策形成时背景，以本更新及交付记录为准。Tailscale 与通知继续暂缓。

## 目标与现状

用户只启动 Hikaro TUI，在 `/pair` 中看到二维码与六位数字配对码；手机只安装 Hikaro，不填写 relay 地址、注册密钥，不另开终端。同一 Wi-Fi 优先直连，跨网络使用默认中转。任务仍在 Mac 执行，Mac 必须在线并保持任务宿主运行。

当前已有 Workers / Durable Objects relay、端到端加密传输和 TUI `/pair` 面板。首次连接仍要求自建 relay 地址与 bootstrap token；默认服务尚未确认部署，六位码兑换与局域网直连尚未实现。现有长配对凭据不能直接截成六位数字。现有操作见[远程连接指南](../remote.md)。

## 决策与取舍

优先复用 Cloudflare Workers + Durable Objects，完成默认中转和配对体验；局域网直连作为独立连接路径完成。Cloudflare 托管公开入口，无需用户购买和维护 VPS；服务维护者仍需 Cloudflare 账号、部署配置、可访问的服务域名及费用管理。默认地址由产品提供，部署凭据和管理员注册密钥不能打包进客户端。

这条路线复用已有实现，也不要求 Android 安装额外 VPN App。相比把 Tailscale 内嵌进 Node TUI 和 React Native App，当前客户端集成成本更低。它不证明 Cloudflare 在中国大陆更快、更稳定或无需代理：必须用用户实际宽带和手机流量验证目标域名的 HTTPS、WebSocket、持续连接与重连，分别记录 Clash 模式及结果。

Workers / Durable Objects 有免费额度，但不能承诺永远免费。请求、计算、存储等有额度或计费限制；免费额度耗尽可能使操作失败。WebSocket Hibernation 可减少符合条件的空闲时长费用，须结合现有实现验证，不能只凭连接数估价。参见 [Cloudflare 计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)和 [Hibernation 示例](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)。

## 实施顺序与完成条件

1. 核实可用账号与部署入口，先验证实际大陆网络可达性，记录宽带/手机流量与 Clash 开关或模式。未部署、未实测时保持未验，本地 dry-run 不代表服务可用。
2. 在现有协议与权限边界上明确默认服务注册、配对兑换和设备确认流程，再实施。六位码用于短期兑换，不作加密密钥；需过期、单次使用、尝试限制和宿主明确确认。具体接口及参数另行设计，本决策不授权重写协议或引入账号体系。
3. `/pair` 管理所需连接资源并直接展示二维码/六位码；首次使用不再索取地址或管理员密钥。服务不可达时给出可操作错误，不自动改变代理设置。
4. 完成局域网发现/直连、中转及路径切换。二维码可携带连接信息；六位码本身不能找到 Mac，必须明确局域网发现或默认服务查询路径。保留草稿、显式发送、任务授权及重连语义。
5. 本地检查后生成签名 Release APK，用户安装后验证真实 relay、网络切换、后台/锁屏/杀进程恢复。功能实现、自动检查、视觉检查、真机验收分别记录。

本轮只记录决策，不部署、不增加依赖、不更改协议。通知配置和收件验收继续暂停，已有部署配置中的通知资源不表示恢复通知工作。常规验证与 APK 构建继续本地运行，Actions 仅用于用户明确决定的发版。

## 暂缓的完整 Tailscale 备选方案

### A：外置客户端

Mac 与 Android 安装官方 Tailscale，登录并加入同一获授权 tailnet。Hikaro 通过 tailnet 地址连接宿主，仍执行自己的配对、设备确认和任务授权。网络层尝试直连，失败时可能使用 DERP 中转；这不是完全没有中转服务器的方案，也不能保证大陆可达。

优点是集成少，适合先验证；代价是用户额外安装、登录和维护连接。Android 通常只有一个活动 VPN 通道，常规 Tailscale App 与 Clash VPN/TUN 存在冲突；macOS 系统代理和 TUN 也要分别实测。不能默认要求关闭 Clash，或承诺两者同时开启一定可用。

### B：桌面内嵌、手机外置

研究 Go `tsnet` 或 `libtailscale` 辅助程序，由 TUI 管理启动、退出和本地通信，将 Hikaro 作为 tailnet 节点。需要处理登录授权、节点身份持久化、注销、版本打包和异常退出。手机仍用官方 App；这减少桌面操作，但未解决 Android 额外 App 与 VPN 冲突，只作为分阶段原型。

### C：两端内嵌

桌面沿 B；Android 研究 Go/C 用户态网络栈与 React Native 原生模块，使 Hikaro 连接通过嵌入栈拨号，不能假设系统 WebSocket 自动走它。先证明编译、网络接口获取、传输桥接、生命周期、重连及 Release 打包可行；目前没有已验证的现成 React Native SDK。

完全不使用 Android `VpnService` 理论上可避开争用系统 VPN 通道，但这是待验证设计，不能承诺与 Clash 共存；底层连接仍可能受系统代理/TUN 影响。内嵌仍需 tailnet 身份授权、控制服务可达性及必要时的中转，不会自动获得无账号六位码配对。Hikaro 的短码发现、设备信任和任务授权仍需完成。

### 恢复时的执行与验收

1. 用户明确恢复后，先用外置客户端验证 Mac/Android、同 Wi-Fi/手机流量的直连与 DERP 回退，记录 Clash 实际模式，不先写两端原生封装。
2. 仅在额外 App 或 VPN 冲突确认为阻碍后，做最小桌面辅助程序与 Android 用户态原型，评估包体、耗电、后台恢复和维护成本。
3. 核对届时服务条款、个人/产品使用范围及依赖许可证。个人免费套餐不代表产品内嵌服务永远免费。
4. 沿用本地预检和签名 APK 交付，用户安装后验证配对、中文输入、审批、停止、网络切换与恢复。原型未通过则保持备选，不替换已工作的连接路径。

暂停期间不加入 Tailscale 依赖、节点凭据、安装引导或原生桥接，也不要求用户安装其 App。

官方参考：[连接方式](https://tailscale.com/docs/reference/connection-types)、[其他 VPN](https://tailscale.com/docs/reference/faq/other-vpns)、[互操作性](https://tailscale.com/docs/reference/interoperability)、[tsnet](https://tailscale.com/docs/features/tsnet)、[libtailscale](https://github.com/tailscale/libtailscale)、[Android 客户端](https://github.com/tailscale/tailscale-android)、[套餐](https://tailscale.com/pricing)。依据核对日期为 2026-10-29，恢复时重新核对支持范围。
