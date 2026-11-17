---
title: 博客开张
published: 2026-11-17
description: 这个博客的由来，以及怎么在这里写文章。
tags: [随笔, 博客]
category: 公告
draft: false
lang: zh_CN
---

换了几个博客工具，最后还是回到了「Markdown + 静态站点」这条路。

## 为什么是这套组合

写博客真正麻烦的从来不是写作，而是**排版、发布和长期维护**。这套组合把这三点拆开：

- **写作**：纯 Markdown 文件，放在 `src/content/posts/` 里
- **排版**：主题负责，想改样式直接改 CSS
- **发布**：`git push` 之后，GitHub Actions 自动构建并部署到 GitHub Pages

好处是内容永远是纯文本，哪天不想用这个主题了，换一个生成器，文章一个字都不用改。

## 写一篇新文章

```bash
pnpm new-post 我的新文章
```

然后在 `src/content/posts/` 下找到刚生成的文件，填好开头那段 frontmatter 就能写了：

```yaml
---
title: 文章标题
published: 2026-11-17
description: 会显示在首页的一句话摘要
tags: [标签1, 标签2]
category: 分类
draft: false
---
```

`draft: true` 的文章只会在本地预览，不会被发布。

## 从别处导入旧文章

之前散落在 Obsidian、Hexo、掘金里的 Markdown 可以批量搬过来：

```bash
pnpm import:md ~/Documents/旧文章/
```

脚本会补全 frontmatter、改写 Obsidian 的双链语法、把本地图片复制到站点里。细节写在 [使用说明](https://github.com/RiverWind1024) 里。

## 一些能用的小功能

代码块带行号和复制按钮：

```python
def greet(name: str) -> str:
    return f"你好，{name}"
```

支持数学公式：$E = mc^2$，也支持提示块：

:::tip
Fuwari 支持 `note` / `tip` / `important` / `caution` / `warning` 五种提示块。
:::

就写到这。下一篇见。
