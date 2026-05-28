const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')
const zlib = require('node:zlib')
const { XMLParser } = require('fast-xml-parser')

const sourceRoot =
  process.env.IMAGE_TOOLS_STYLE_LIBRARY_DIR || 'D:\\tmp\\image-tool-lib\\风格'
const outputRoot = path.resolve(process.cwd(), 'public', 'style-library')
const assetRoot = path.join(outputRoot, 'assets')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function normalizeStyleFilenameValue(value) {
  return String(value || '').replace(/ |\_/g, '').toLowerCase()
}

function fileUrlSegment(value) {
  return encodeURIComponent(String(value)).replace(/%2F/gi, '/')
}

function chunkFilename(category) {
  return `${crypto.createHash('sha1').update(String(category)).digest('hex').slice(0, 16)}.json`
}

function styleId(category, name) {
  return crypto.createHash('sha1').update(`${category}/${name}`).digest('hex').slice(0, 32)
}

function columnIndex(cellRef) {
  const letters = String(cellRef || 'A1').replace(/[^A-Za-z]/g, '').toUpperCase()
  let index = 0
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return Math.max(0, index - 1)
}

function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function readZipEntry(zipBuffer, entryName) {
  const signature = 0x04034b50
  let offset = 0

  while (offset < zipBuffer.length - 30) {
    if (zipBuffer.readUInt32LE(offset) !== signature) break
    const method = zipBuffer.readUInt16LE(offset + 8)
    const compressedSize = zipBuffer.readUInt32LE(offset + 18)
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26)
    const extraLength = zipBuffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = zipBuffer.toString('utf8', nameStart, nameStart + fileNameLength)
    const dataStart = nameStart + fileNameLength + extraLength
    const dataEnd = dataStart + compressedSize

    if (name === entryName) {
      const data = zipBuffer.subarray(dataStart, dataEnd)
      if (method === 0) return data
      if (method === 8) return zlib.inflateRawSync(data)
      throw new Error(`Unsupported zip method ${method} for ${entryName}`)
    }

    offset = dataEnd
  }

  return null
}

function textValue(node) {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textValue).join('')
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text'] || '')
    if ('t' in node) return textValue(node.t)
    if ('r' in node) return textValue(asArray(node.r).map((item) => item.t))
  }
  return ''
}

function decodeCellText(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function readXlsxRows(filePath) {
  const zip = fs.readFileSync(filePath)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
  })
  const sharedRaw = readZipEntry(zip, 'xl/sharedStrings.xml')
  const sharedStrings = sharedRaw
    ? asArray(parser.parse(sharedRaw.toString('utf8')).sst?.si).map(textValue)
    : []
  const sheetRaw = readZipEntry(zip, 'xl/worksheets/sheet1.xml')
  if (!sheetRaw) return []

  const sheet = parser.parse(sheetRaw.toString('utf8'))
  const rows = asArray(sheet.worksheet?.sheetData?.row)
  return rows.map((row) => {
    const values = []
    for (const cell of asArray(row.c)) {
      const index = columnIndex(cell.r)
      while (values.length <= index) values.push('')
      if (cell.t === 's') {
        values[index] = decodeCellText(sharedStrings[Number(cell.v)] || '')
      } else if (cell.t === 'inlineStr') {
        values[index] = decodeCellText(textValue(cell.is))
      } else {
        values[index] = decodeCellText(textValue(cell.v))
      }
    }
    return values
  })
}

function findStyleImage(categoryDir, styleName, marker) {
  const normalizedName = normalizeStyleFilenameValue(styleName)
  const files = fs.readdirSync(categoryDir, { withFileTypes: true })
  for (const file of files) {
    if (!file.isFile()) continue
    const ext = path.extname(file.name).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue
    const stem = path.basename(file.name, ext)
    if (!stem.includes(`-${marker}`)) continue
    if (normalizedName && normalizeStyleFilenameValue(stem).includes(normalizedName)) {
      return path.join(categoryDir, file.name)
    }
  }
  return ''
}

function copyAsset(sourcePath, id, kind) {
  if (!sourcePath) return undefined
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg'
  const filename = `${id}-${kind}${ext}`
  fs.copyFileSync(sourcePath, path.join(assetRoot, filename))
  return `./style-library/assets/${fileUrlSegment(filename)}`
}

function build() {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Style library not found: ${sourceRoot}`)
  }

  removeDir(outputRoot)
  ensureDir(assetRoot)

  const categories = []
  const stylesByCategory = new Map()
  const categoryDirs = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sourceRoot, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN'))

  for (const categoryDir of categoryDirs) {
    const category = path.basename(categoryDir)
    const xlsx = fs
      .readdirSync(categoryDir)
      .filter((name) => name.endsWith('Json.xlsx'))
      .sort()[0]
    if (!xlsx) continue

    let count = 0
    const rows = readXlsxRows(path.join(categoryDir, xlsx))
    for (const row of rows.slice(1)) {
      const name = String(row[0] || '').trim()
      const rawJson = String(row[1] || '').trim()
      if (!name || !rawJson) continue

      let styleJson
      try {
        styleJson = JSON.parse(rawJson)
      } catch {
        continue
      }

      const id = styleId(category, name)
      const preview = findStyleImage(categoryDir, name, '风格')
      const source = findStyleImage(categoryDir, name, '原')
      const keywords = Array.isArray(styleJson.style_keywords) ? styleJson.style_keywords : []
      const style = {
        id,
        category,
        name,
        styleJson,
        keywords,
        previewUrl: copyAsset(preview, id, 'preview'),
        sourceUrl: copyAsset(source, id, 'source'),
      }
      if (!stylesByCategory.has(category)) stylesByCategory.set(category, [])
      stylesByCategory.get(category).push(style)
      count += 1
    }

    if (count) {
      categories.push({
        name: category,
        count,
        href: `./style-library/categories/${chunkFilename(category)}`,
      })
    }
  }

  ensureDir(path.join(outputRoot, 'categories'))
  for (const [category, styles] of stylesByCategory) {
    fs.writeFileSync(
      path.join(outputRoot, 'categories', chunkFilename(category)),
      JSON.stringify({ category, styles }, null, 2)
    )
  }

  const styles = [...stylesByCategory.values()].flat()
  const styleSummaries = styles.map(({ styleJson, ...style }) => style)
  const library = {
    root: 'public/style-library',
    categories,
    styles: styleSummaries,
  }
  fs.writeFileSync(path.join(outputRoot, 'index.json'), JSON.stringify(library, null, 2))
  console.log(`Built ${styles.length} styles into ${outputRoot}`)
}

build()
