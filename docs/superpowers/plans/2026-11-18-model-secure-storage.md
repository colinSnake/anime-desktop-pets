# 多厂商模型迁移第二段：安全凭证与原子配置

日期：2026-11-18。依据独立多厂商设计与用户本轮明确授权，在当前 `codex/cross-platform-foundation` 工作区内实施；不创建提交、不推送、不改写设计原稿。沿用 Electron／Fastify／TypeScript／Python，不重新搭建架构。本段不接生产桥或页面。

## 选择与边界

采用独立的服务内部模型配置仓库与可注入安全凭证端口。凭证端口只接受固定应用 service、随机不可变 account；可信宿主后续负责把该端口适配到系统安全凭证库。没有后端时明确不可用，不提供文件／环境变量／命令行明文降级。本轮完成注入后端的事务与请求闭环，不声称已验证真实 Keychain 或系统授权。

配置只落在可信宿主指定的新隔离模型目录，不读取旧 `model-provider.json`。普通 JSON 不含 Key、前缀或密钥哈希。配置读取不触发凭证读取。保留32连接、每连接33模型、1MiB、schema v2、双层显式默认、稳定模型 entryID 和现有路由指纹。

## 文件与具体接口

- `apps/app-service/src/models/private-directory.ts`：私有目录和有界普通文件读写；逐层拒绝 symlink，目录0700、文件0600、同用户、单硬链接；打开后复核 inode/dev。独立临时文件写入并 fsync，发布前复核原文件，最后 rename；目录同步结果单独报告，不能因 rename 后同步失败误删已发布凭证。Windows 未具备可信 ACL 检查时明确阻塞。
- `configuration-store.ts`：`read()`、`commit(expectedRevision, transform)`；进程内串行队列与短期排他文件锁，锁内重新读取及校验，版本不符返回 conflict；损坏／未知版本／读取失败拒绝写入，只有未观察到配置且未发生读取失败的目标文件确实 ENOENT 才是空配置。崩溃残留锁不自动抢占。
- `credentials.ts`：`SecureCredentialBackend` 的 `create/read/remove` 注入端口，`CredentialVault.prepare(connectionID,key)` 返回本次所有权句柄，`read(ref,signal,connectionID)` 在线读取验证本应用版本引用与连接归属；所有后端异常映射固定错误，无 cause／正文。每次替换随机新引用，create 必须仅新增。失败清理仅接受本 vault 签发且未发布的所有权句柄；不枚举、不清理旧引用或其他应用项目。
- `repository.ts`：异步 `open()` 后提供同步配置快照；`saveConnection(connection, expectedConnectionRevision, credentialChange)`、`removeConnection(id, expectedConnectionRevision, replacementDefault)`、`setDefault(expectedRevision, connectionID, modelEntryID)`（connectionID显式null清空全局默认）。普通保存不能任意绑定 credentialRef；未提供 Key 保留原引用，删除 Key 使用显式操作。准备新 Key 后在短锁事务内重新检查版本，发布后才更新快照；失败保留旧有效配置和旧 Key，清理结果单独报告。连接删除成功后撤销该连接全部在途操作；普通保存不污染旧请求快照。
- `client.ts`：增加内部连接撤销绑定；删除取消凭证等待／HTTP／发现，不依赖上游遵守 abort；相同ID重新建立也不能接收已撤销世代的迟到结果。不自动切厂商。
- `test/model-storage.test.ts`、`test/model-credentials.test.ts`、`test/model-repository.test.ts` 及客户端回归：临时目录、合成凭证、注入后端／假fetch，不访问真实Keychain或模型服务。

核心调用形状：

```ts
const vault = new CredentialVault(injectedSecureBackend);
const repository = await ModelRepository.open(new ModelConfigurationStore(isolatedRoot), vault);
await repository.saveConnection(draftWithoutCredentialRef, 0, { kind: 'replace', key: syntheticKey });
const client = await repository.createClient({ fetch: syntheticFetch });
// 仅测试／可信内部消费者使用；没有生产HTTP、IPC或renderer入口。
```

## 执行顺序与失败先行

1. [x] 写凭证端口回归：独立版本、不串连接、缺Key、非法输入、后端错误脱敏、仅本次未发布项目可清理；运行 `pnpm exec tsx --test apps/app-service/test/model-credentials.test.ts` 观察RED，再实现并转GREEN。
2. [x] 写磁盘回归：缺文件／重开、私有权限、符号链接／硬链接／非普通文件、坏JSON／未知版本／非法UTF-8／超限、并发排队、跨仓库锁、revision冲突及发布前失败；观察RED，再实现并转GREEN。
3. [x] 写事务回归：缺Key保存、多连接合并、默认原子提交、同连接冲突、新凭证准备失败／配置失败／清理失败均保留旧版本、不读旧资料、不可任意重绑定引用；观察RED，再实现并转GREEN。
4. [x] 写请求撤销回归：凭证等待中删除、HTTP／发现中删除、忽略abort的迟到结果、同ID重建、普通保存保持旧快照；观察RED，再接内部client闭环并转GREEN。
5. [x] 自审错误／竞态／引用所有权与边界，补失败先行回归。更新迁移清单、中英文README、开发文档、路线图和实际验证记录。
6. [x] 执行新增定向回归、`pnpm run check:cross-platform`、可信Qt/Fusion/offscreen播放器／增强运行时／合成真实适配器、`python3 scripts/check-project.py`、`git diff --check`（另检查新文件）。逐项记录退出状态／通过／失败／跳过与未验收边界。

## 不在本段开放

真实Keychain适配／权限请求、旧资料导入、生产模型HTTP／IPC／renderer桥、双层内联模型页、逐连接UI草稿、模型选择、正式聊天、刷新合并、真实网络／费用、桌面预览、helper重建／安装。正式发送与模型选择保持禁用；现有桌宠布局、首帧／停止确认、三实例门禁、暂停／任务及Windows/Linux播放器blocked保持原有边界。

旧凭证版本保守保留，不提供跨进程在途租约不完整时的自动GC；意外退出产生的孤立新增项目不影响有效配置，只能后续按明确所有权恢复处理。目录fsync失败会返回“已发布但持久性未确认”，不能报告连接成功或当作未发布回滚；操作系统崩溃／断电持久性与真实授权另行验收。

## 实施复核补充

- 全局提交序号也用于本次改变的连接revision，并拒绝磁盘连接revision大于全局序号，防删除重建后的编辑ABA；显示名仍不参与路由指纹。
- `createClient()` 异步取得profile在线所有权标记并重载配置；该标记覆盖客户端和全部写入者，只有持有私有令牌的仓库能提交或释放，即使共享store也不能借用。它不替代短期配置写锁，也不在凭证后端／HTTP等待中持有配置写锁；并发close共享结果，排空后在短锁下按inode释放，失败可重试，残留标记不自动接管。
- 凭证读取传入快照connectionID，验证存储封装归属；磁盘交换两条合法引用也不能串Key。没有真实安全后端实现或主进程接线，不能把注入测试说成真实Keychain已交付。
- macOS固定只读metadata命令保守拒绝所有ACL；独占文件创建后fchmod并验证权限，发布前按inode＋bytes再核验临时文件。Windows缺可信ACL核验时明确阻塞，POSIX磁盘测试在Windows跳过并另测阻塞；当前macOS本轮无跳过。
- 独立只读审查复现4类问题，新增6项失败回归后修复：凭证归属、rename后报错、第二写入者绕过撤销、umask／macOS ACL。第二轮审查补4项回归，覆盖同store隔离、不确定发布在异步清锁前取消、并发close和释放重试。另补4项回归，覆盖读取异常后文件消失、落盘只接收本应用引用，以及注入传输不可替换内部凭证读取器。原设计SHA-256保持 `30f41531c08c0a5db3fa866750f7e205f078d0e54091dda32bbfef9bd620192d`。
- 当前本轮模型定向115项、跨平台334项、Qt播放器10项、增强运行时159项、真实适配器合成45项、项目规则33项通过；最终实际命令／日志／边界以[实际验证记录](../../实际验证记录.md)为准。不代表真实授权、网络兼容、费用、UI或桌面已验收。
