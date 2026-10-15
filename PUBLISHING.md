# 发布到 DSH 社区插件市场

本文记录 2026-10-16 核对的社区市场规则。`dsh-market` 是社区市场应用，不是 DeepSeek 官方审核服务；收录不等于安全背书。以[目录贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)及[市场提交说明](https://github.com/dsh-market/dsh-market/blob/main/README.zh.md#提交你的插件)的后续版本为准。

## 本地已具备什么

本目录有真实可运行的插件、`dsh.bundle` manifest、匹配的 `cordis.patch.yml`、配置 schema、双语使用说明、MIT 许可证、功能测试与真实 loader 组合测试。`npm pack` 直接包含 JavaScript，不需要安装时执行构建脚本。兼容性声明保守限定在已测试的两个预发布版本，不能据此宣称支持最新 DSH。

公开源码仓库为 [WaterFountain-Jack/dsh-study-note](https://github.com/WaterFountain-Jack/dsh-study-note)，创建于 2026-10-16。工作包名为 `dsh-study-note`，未发布到 npm；2026-10-15 查询 registry 返回 E404，不代表已保留该名称或保证发布权限。创建仓库不代表市场收录，也不会修改用户的日常 profile。

## 想让市场能搜到，还缺什么

1. 使用独立仓库 [WaterFountain-Jack/dsh-study-note](https://github.com/WaterFountain-Jack/dsh-study-note) 发布，不包含其他学习资料或整个 DSH checkout。清单中的 `repository` 指向该仓库，文档使用通用示例路径。
2. 在公开仓库提交源码、`package.json`、patch、README、LICENSE 和测试。为仓库添加 `dsh-plugin` topic。仓库需创建满 **1 天**；当前没有提交数量门槛。
3. 在目标用户实际运行的宿主上验证安装和整理。目前已测试 0.1.0-rc.8 与本地 0.1.1-rc.2；正式面向新用户发布前，还要验证最新版本并据实调整对等依赖。最好补一次真实模型的人工验收，确认追问合并、错误修正、费用和敏感文本留存都符合预期。
4. 仓库创建满 1 天后，到 **awesome-dsh-plugin/awesome-dsh-plugin** 提交收录 PR，不是到 `dsh-market/dsh-market`。新增 `data/plugins/WaterFountain-Jack__dsh-study-note.yml`，内容见[条目模板](market/plugin-entry.yml.example)。不要手改自动生成的 README，也不要添加手写 `npm:` 字段。
5. 等待 CI 和维护者审核。CI 通过只是前提；维护者还检查代码是否真实可用、描述是否准确、是否存在重复功能和明显安全问题。条目合并后由目录构建及市场同步收录，不能保证立即可搜索。市场应用说明通常一天内生效。

推荐 `category: docs`，描述强调“逐对话 opt-in、结构化学习笔记和 Markdown 索引”，不要宣称具有尚未实现的审核流、跨对话知识图谱或自动事实核验。

## npm 发布是可选项，但推荐

只在 GitHub 提供可安装的组合包也能申请收录，npm 不是市场搜索的前提。市场优先使用与仓库验证匹配的 npm 包，其次 GitHub Release 中的预构建 tarball，最后 GitHub 源码。

如果选择 npm，先将 `package.json` 的 `repository` 写成真实的公开仓库 URL；包名改成你有权限的唯一名称或 scope，patch 内的插件包名也一起修改。`repository` 不匹配，目录无法自动关联 npm 包。不要把占位仓库写入将要发布的清单。

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/WaterFountain-Jack/dsh-study-note.git"
  }
}
```

在仓库中运行测试、真实宿主冒烟和打包检查，再登录你的 npm 账号公开发布。以下操作会公开代码，需由你确认后执行：

```sh
npm run check
npm test
npm run test:dsh
npm pack --dry-run
npm login
npm publish --access public
```

仓库与 npm 包的映射由目录自动采集，不需要在收录 YAML 填包名。npm 发布成功只表示能通过包名安装，仍需完成前面的目录收录才能在市场搜索到。不要用“已发 npm”代替“已上架”。

## 可选展示材料

建议提供一张 `/note on` 和 `/note status` 截图、一张笔记与索引截图。去除真实会话、敏感路径和秘密。在自己的仓库里添加 `screenshots.json`，列 1–8 张相对图片路径；没有截图不影响收录。不要伪造截图或将私人审计请求作为展示素材。

## 验收安装，不必等待收录

生成的本地 tgz 已可通过 `dsh plugin --profile <你的profile> add <压缩包绝对路径>` 安装。先用独立测试 profile 验证；这个命令会修改指定 profile。安装后检查 `--dump-config` 中的 `study-note` 配置项，再在真实对话开启记录、提问、检查生成文档和根索引，最后验证关闭不再整理。发布、市场收录和修改日常 profile 都需要单独确认。
