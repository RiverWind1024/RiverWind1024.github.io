#!/usr/bin/env node
/**
 * 把已有的 Markdown 文章导入为 Fuwari 可用的文章。
 *
 * 支持单个文件或整个目录（递归），会：
 *   1. 补全 / 映射 frontmatter（兼容 Obsidian、Hexo、Hugo、Jekyll 等常见字段）
 *   2. 删除与标题重复的首个 H1
 *   3. 转换 Obsidian 的双链语法
 *   4. 复制本地图片到 public/imported/<slug>/ 并改写引用
 *
 * 用法：
 *   pnpm import:md <文件或目录> [选项]
 *
 * 选项：
 *   --slug <name>      指定文章文件名（仅单文件时有意义）
 *   --category <name>  指定分类
 *   --tags <a,b>       追加标签，逗号分隔
 *   --draft            标记为草稿
 *   --no-images        不复制本地图片，保留原始引用
 *   --force            覆盖已存在的同名文章
 *   --dry-run          只打印结果，不写入文件
 *
 * 示例：
 *   pnpm import:md ~/Documents/旧文章/
 *   pnpm import:md ./note.md --category 随笔 --tags 读书,笔记
 */

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import matter from "gray-matter"

const POSTS_DIR = path.resolve("src/content/posts")
const PUBLIC_DIR = path.resolve("public")

/** 解析命令行参数 */
function parseArgs(argv) {
  const flags = { images: true, draft: false, force: false, dryRun: false }
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--slug":
        flags.slug = argv[++i]
        break
      case "--category":
        flags.category = argv[++i]
        break
      case "--tags":
        flags.tags = argv[++i]
        break
      case "--draft":
        flags.draft = true
        break
      case "--no-images":
        flags.images = false
        break
      case "--force":
        flags.force = true
        break
      case "--dry-run":
        flags.dryRun = true
        break
      case "-h":
      case "--help":
        flags.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new Error(`未知选项：${arg}`)
        }
        positional.push(arg)
    }
  }

  return { flags, positional }
}

/** 递归收集 Markdown 文件 */
function collectMarkdown(target) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]

  const files = []
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    // 跳过隐藏目录和 Obsidian 的 .trash / 附件目录
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMarkdown(full))
    } else if (/\.(md|mdx)$/i.test(entry.name)) {
      files.push(full)
    }
  }
  return files.sort()
}

/** 取第一个存在的字段值 */
function pick(data, keys) {
  for (const key of keys) {
    const value = data[key]
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

/** 把各种日期写法统一成 YYYY-MM-DD */
function normalizeDate(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value)
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim()
    // 2024-01-01 / 2024/01/01 / 2024-01-01 12:30:00
    const match = text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/)
    if (match) {
      const [, y, m, d] = match
      return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
    }
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) return formatDate(parsed)
  }
  return formatDate(fallback)
}

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** 把标签字段归一成字符串数组 */
function normalizeTags(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeTags(item))
  }
  return String(value)
    .split(/[,，、]/)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
}

/** 生成 URL 友好的文件名，保留中文 */
function toSlug(name) {
  return name
    .trim()
    .replace(/\.(md|mdx)$/i, "")
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "")
}

/** 去掉 Markdown 标记，用于自动生成摘要 */
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`~_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** 正文首个 H1 作为标题，并从正文里移除 */
function extractH1(body) {
  const match = body.match(/^\s*#\s+(.+?)\s*$/m)
  if (!match) return { title: undefined, body }
  const title = match[1].trim()
  const stripped = body.replace(match[0], "").replace(/^\s*\n/, "")
  return { title, body: stripped }
}

/** 转换 Obsidian 的 wiki 链接语法 */
function convertObsidianSyntax(body) {
  return (
    body
      // ![[image.png]] / ![[image.png|300]] -> ![](./image.png)
      .replace(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g, (_, file) => {
        return `![](${file.trim()})`
      })
      // [[page|alias]] -> alias
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\|([^\]]+)\]\]/g, (_, _page, alias) => alias.trim())
      // [[page]] -> page
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\]\]/g, (_, page) => page.trim())
      // ==高亮== -> **高亮**
      .replace(/==([^=]+)==/g, "**$1**")
  )
}

/** 判断是否是需要特殊处理的外部引用 */
function isExternal(ref) {
  return /^(https?:)?\/\//i.test(ref) || /^(data|mailto|tel):/i.test(ref)
}

/**
 * 复制一个本地资源到 public/imported/<slug>/，返回新的绝对路径。
 * 复制失败或文件不存在时返回 null，由调用方保留原引用。
 */
function copyAsset(rawRef, srcDir, slug, usedNames) {
  const ref = rawRef.replace(/^<|>$/g, "").split(/[?#]/)[0]
  if (!ref || isExternal(ref)) return null
  // /xxx 开头的引用指向 public，无需处理
  if (ref.startsWith("/")) return null

  const decoded = decodeURIComponent(ref)
  const absSrc = path.resolve(srcDir, decoded)
  if (!fs.existsSync(absSrc) || !fs.statSync(absSrc).isFile()) return null

  let baseName = path.basename(absSrc).replace(/\s+/g, "-")
  if (usedNames.has(baseName)) {
    const ext = path.extname(baseName)
    const stem = path.basename(baseName, ext)
    let i = 2
    while (usedNames.has(`${stem}-${i}${ext}`)) i++
    baseName = `${stem}-${i}${ext}`
  }
  usedNames.add(baseName)

  const destDir = path.join(PUBLIC_DIR, "imported", slug)
  const absDest = path.join(destDir, baseName)
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(absSrc, absDest)

  return `/imported/${slug}/${baseName}`
}

/** 改写正文里的图片引用 */
function rewriteImages(body, srcDir, slug, usedNames) {
  return body.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)([^)]*)\)/g,
    (full, alt, ref, rest) => {
      const next = copyAsset(ref, srcDir, slug, usedNames)
      if (!next) return full
      return `![${alt}](${next}${rest})`
    },
  )
}

/** 输出 YAML 双引号字符串（JSON 转义在 YAML 中同样合法） */
function yamlString(value) {
  return JSON.stringify(String(value ?? ""))
}

/**
 * 手工拼接 frontmatter。
 * 不用 gray-matter 的 stringify：它会把日期加上引号输出成字符串，
 * 而 Fuwari 的 schema 要求 published 是 Date，带引号会导致构建失败。
 */
function buildFrontmatter(fm) {
  const lines = ["---"]
  lines.push(`title: ${yamlString(fm.title)}`)
  lines.push(`published: ${fm.published}`)
  if (fm.updated) lines.push(`updated: ${fm.updated}`)
  lines.push(`description: ${yamlString(fm.description)}`)
  if (fm.image) lines.push(`image: ${yamlString(fm.image)}`)
  lines.push(`tags: [${fm.tags.map((tag) => yamlString(tag)).join(", ")}]`)
  lines.push(`category: ${yamlString(fm.category)}`)
  lines.push(`draft: ${fm.draft ? "true" : "false"}`)
  lines.push("---")
  return `${lines.join("\n")}\n\n${fm.body.trim()}\n`
}

/** 处理单个文件 */
function importFile(file, flags, report) {
  const raw = fs.readFileSync(file, "utf-8")
  const parsed = matter(raw)

  let body = convertObsidianSyntax(parsed.content)
  const data = parsed.data ?? {}

  // 标题：frontmatter -> 首个 H1 -> 文件名
  let title = pick(data, ["title", "name"])
  if (!title) {
    const extracted = extractH1(body)
    title = extracted.title
    body = extracted.body
  } else {
    // frontmatter 已有标题时，去掉正文里重复的 H1
    const extracted = extractH1(body)
    if (extracted.title && extracted.title === String(title).trim()) {
      body = extracted.body
    }
  }
  title = String(title?.trim() || path.basename(file, path.extname(file)))

  // 文件名：显式 --slug 优先（仅单文件导入时），其次源文件名
  const baseSlug = flags.slug && flags.single
    ? flags.slug
    : toSlug(path.basename(file, path.extname(file)))
  let slug = baseSlug
  let outPath = path.join(POSTS_DIR, `${slug}.md`)
  if (!flags.force) {
    let i = 2
    while (fs.existsSync(outPath)) {
      slug = `${baseSlug}-${i++}`
      outPath = path.join(POSTS_DIR, `${slug}.md`)
    }
  }

  // 日期：frontmatter -> 文件修改时间
  const stat = fs.statSync(file)
  const published = normalizeDate(
    pick(data, ["published", "date", "pubDate", "created", "createdAt"]),
    stat.mtime,
  )
  const updatedRaw = pick(data, ["updated", "lastmod", "modified", "updatedAt"])

  // 标签与分类
  const tags = normalizeTags(pick(data, ["tags", "keywords", "tag"]))
  const extraTags = normalizeTags(flags.tags)
  const category =
    flags.category ||
    pick(data, ["category", "categories", "section"]) ||
    ""

  // 摘要：frontmatter -> 正文前 120 字
  const description =
    String(pick(data, ["description", "summary", "excerpt", "abstract"]) ?? "").trim() ||
    stripMarkdown(body).slice(0, 120)

  if (flags.images) {
    body = rewriteImages(body, path.dirname(file), slug, new Set())
  }

  const frontmatter = {
    title,
    published,
    description,
    tags,
    category: Array.isArray(category) ? String(category[0] ?? "") : String(category),
    draft: flags.draft || Boolean(pick(data, ["draft"])) || data.published === false,
  }

  // 封面图：能本地复制的就复制，否则原样保留
  const cover = pick(data, ["image", "cover", "banner", "thumbnail"])
  if (cover) {
    const next = flags.images && typeof cover === "string"
      ? copyAsset(cover, path.dirname(file), slug, new Set())
      : null
    frontmatter.image = next || String(cover)
  }

  if (updatedRaw) {
    frontmatter.updated = normalizeDate(updatedRaw, stat.mtime)
  }

  const output = buildFrontmatter({ ...frontmatter, body })

  if (!flags.dryRun) {
    fs.mkdirSync(POSTS_DIR, { recursive: true })
    fs.writeFileSync(outPath, output, "utf-8")
  }

  report.push({ file, outPath: flags.dryRun ? "(dry-run)" : outPath, title, slug, tags, draft: frontmatter.draft })
}

function printHelp() {
  console.log(`用法：pnpm import:md <文件或目录> [选项]

选项：
  --slug <name>      指定文章文件名（仅单文件时有意义）
  --category <name>  指定分类
  --tags <a,b>       追加标签，逗号分隔
  --draft            标记为草稿
  --no-images        不复制本地图片
  --force            覆盖同名文章
  --dry-run          只打印结果，不写文件`)
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))

  if (flags.help) {
    printHelp()
    return
  }
  if (positional.length === 0) {
    printHelp()
    process.exit(1)
  }

  const target = positional[0]
  if (!fs.existsSync(target)) {
    console.error(`路径不存在：${target}`)
    process.exit(1)
  }

  const files = collectMarkdown(target)
  if (files.length === 0) {
    console.error("没有找到 .md / .mdx 文件")
    process.exit(1)
  }

  const report = []
  const failed = []
  for (const file of files) {
    try {
      importFile(file, { ...flags, single: files.length === 1 }, report)
    } catch (error) {
      failed.push({ file, error })
    }
  }

  console.log(`\n共处理 ${files.length} 个文件，成功 ${report.length} 个，失败 ${failed.length} 个\n`)
  for (const item of report) {
    const draftMark = item.draft ? " [草稿]" : ""
    console.log(`✔ ${item.title}${draftMark}`)
    console.log(`  ${item.file}`)
    console.log(`  → ${item.outPath}`)
    if (item.tags.length) console.log(`  标签: ${item.tags.join(", ")}`)
  }
  for (const item of failed) {
    console.error(`✘ ${item.file}`)
    console.error(`  ${item.error.message}`)
  }

  if (failed.length) process.exit(1)
}

main()
