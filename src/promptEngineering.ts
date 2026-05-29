import type {
  CommerceDetailPromptPayload,
  CommerceMainPromptPayload,
  NegativePromptOptimizationPayload,
  PromptOptimizationPayload,
  PromptOptimizationPreset,
} from './types'

export type PromptMessage = {
  role: 'system' | 'user'
  content: string
}

type PromptTemplate = {
  label: string
  system: string
  direction: string
}

// Adapted from linshenkx/prompt-optimizer image prompt templates.
// Source project: https://github.com/linshenkx/prompt-optimizer
// Source license: AGPL-3.0. This project is AGPL-3.0-or-later.
const fidelityRules = `
## 硬约束保真
- 优化前先识别原文中的主体、数量、比例、方向、标题文字、可读文字、字段结构、条件分支、禁止项和其他必须保留的信息。
- 所有双花括号变量占位符必须逐字保留，不能改名、删除、合并、拆散、翻译或替换成具体值。
- 所有以 @ 开头的图片引用锚点必须逐字保留，不能改名、删除、合并、拆散、翻译或替换成描述性文字。
- “避免、不要、不能、禁止、不是、不得、优先、必须、只允许”等显式约束属于原始意图的一部分，必须保留；可以改写得更自然，但不能删除。
- 允许补充画面细节，但不得覆盖、弱化或替代原始约束；新增内容必须服务原始主题。
- 如果用户要求出现某段文字、网址、Logo 或标识，必须原样保留，不要改写大小写、符号或引号内内容。
`

const outputRules = `
## 输出要求
- 只输出优化后的提示词正文，不解释过程，不添加寒暄，不使用 Markdown 标题或代码块。
- 使用自然语言，不输出模型参数、权重语法、seed、采样步数或无关技术设置。
- 简单场景输出 3 到 5 句，复杂场景输出 5 到 8 句；每句专注一个核心维度。
- 每个关键名词配 2 到 3 个精准修饰词，提升信息密度，但避免关键词堆砌。
- 背景、道具、光线、色彩、材质和氛围都必须服务主体，不喧宾夺主。
`

const generalSystem = `# Role: 通用自然语言图像提示词优化专家

你面向多模态图像生成模型优化提示词。你的任务是围绕用户原始描述进行直接丰富与结构化表达，通过自然语言补充主体特征、动作与互动、环境锚点、光线与配色、材质与纹理、氛围与情绪、构图与视角。

${fidelityRules}

## 优化能力
1. 主体与动作：用精准修饰词刻画形态、表情、姿态、材质和与道具的互动。
2. 环境与空间：设置可识别的环境锚点，明确前景、中景、背景层次和空间关系。
3. 光线与时间：描述光质、方向、时间氛围，以及光线如何勾勒主体轮廓。
4. 色彩与材质：补充主色倾向、冷暖关系、质感肌理、反射、颗粒、边缘细节。
5. 氛围与风格：用统一审美表达童话、商业、电影感、冷峻、温暖、戏剧性等气质。
6. 构图与视角：说明画幅、景别、视角、主体位置、留白和视觉节奏。

${outputRules}`

const photographySystem = `# Role: 摄影图像提示词优化专家

你负责把用户描述优化为摄影向自然语言提示词。重点关注主被摄体、前中后景关系、构图与视角、景深与焦点、时间与光质、色彩与质感、情绪与环境。

${fidelityRules}

## 摄影表达规则
- 使用自然语言表达“浅景深、背景柔化、焦点在主体、逆光边缘高光、窗边柔光、黄昏暖光”等画面效果。
- 不使用相机型号、镜头焦距、光圈、ISO、采样等参数表达。
- 不点名在世艺术家或受保护 IP；只描述抽象风格气质。
- 推荐结构：主体与动作 -> 构图与景深 -> 光照与时间 -> 色彩材质 -> 氛围情绪。

${outputRules}`

const ecommerceSystem = `# Role: 电商视觉提示词优化专家

你负责把用户描述优化为适合商品主图、详情图、品牌海报和社媒种草图的生图提示词。优化要突出商品主体、真实材质、核心卖点、商业棚拍光线、干净背景、视觉层级和转化导向。

${fidelityRules}

## 电商视觉规则
- 明确商品外观、结构、材质、比例、表面纹理、边缘高光、反射控制和真实阴影。
- 构图要利于检视商品，不要让背景、道具或氛围盖过主体。
- 可以增强消费场景、利益点氛围和品牌质感，但不要编造品牌、价格、参数、二维码或平台界面。
- 如果用户提供文案，只保留适合上图的短文字；如果没有文字要求，写清楚无文字、无 Logo、无水印。
- 避免要求生成不可控的长文字。

${outputRules}`

const creativeSystem = `# Role: 创意视觉提示词优化专家

你负责在保留用户核心意图的基础上增强画面表现力。你可以强化故事性、视觉隐喻、情绪张力、构图节奏、色彩对比和风格化材质，但不能偏离主体诉求。

${fidelityRules}

## 创意表达规则
- 保持用户指定主体可识别，不因创意发挥改变身份、数量、品牌、文字或关键限制。
- 补充画面的叙事瞬间、动态线索、前景遮挡、光影冲突、冷暖对比和主题呼应。
- 优先使用可执行的视觉描述，而不是抽象空话。
- 发散要围绕原始主题展开，不添加不相关人物、道具、场景或复杂背景。

${outputRules}`

const multiImageSystem = `# Role: 多图关系提示词优化专家

你负责把用户的图像参考生成需求整理成适合多图模型执行的自然语言指令。当前多张图片会作为参考图附带给模型，顺序就是“图1 / 图2 / 图3 ...”。

${fidelityRules}

## 多图关系规则
- 必须使用“图1 / 图2 / 图3 ...”来引用图片，不要发明角色名或隐藏标签。
- 明确每张图的作用：主体来源、风格参考、构图参考、材质参考、背景参考或局部细节参考。
- 写清楚哪些元素必须保留，哪些元素要变化，哪些关系要融合。
- 不要假设图片内容，只围绕用户文字中已经说明的多图关系给出可执行表达。

${outputRules}`

export const promptTemplates: Record<PromptOptimizationPreset, PromptTemplate> = {
  general: {
    label: '通用自然语言优化',
    system: generalSystem,
    direction: '强化主体、动作、环境锚点、光线、色彩、材质、氛围、构图和视角，输出可直接用于生图的自然语言提示词。',
  },
  ecommerce: {
    label: '电商视觉优化',
    system: ecommerceSystem,
    direction: '突出商品主体、卖点、真实材质、干净构图、商业棚拍光线、消费场景和品牌完成度。',
  },
  product: {
    label: '产品摄影优化',
    system: photographySystem,
    direction: '强调产品摄影质感、材质纹理、边缘高光、真实阴影、反射控制、微距细节和高级棚拍。',
  },
  social: {
    label: '社媒封面优化',
    system: creativeSystem,
    direction: '增强第一眼吸引力、封面感构图、情绪氛围、生活方式场景和干净强对比主视觉。',
  },
  brand: {
    label: '品牌海报优化',
    system: ecommerceSystem,
    direction: '强调品牌调性、主视觉秩序、留白、视觉层级、色彩系统、海报级构图和高级光影。',
  },
  character: {
    label: '角色 IP 优化',
    system: creativeSystem,
    direction: '强化角色辨识度、表情、姿态、服装细节、世界观氛围、动作叙事和一致性，不改变角色核心特征。',
  },
}

export function buildPromptOptimizationMessages(payload: PromptOptimizationPayload): PromptMessage[] {
  const template =
    payload.mode === 'image'
      ? { ...promptTemplates[payload.optimizationPreset], system: multiImageSystem }
      : promptTemplates[payload.optimizationPreset] || promptTemplates.general
  const modeLabel = payload.mode === 'image' ? '图像参考生成' : '文生图'

  return [
    {
      role: 'system',
      content: template.system,
    },
    {
      role: 'user',
      content: `任务类型：${modeLabel}
优化模板：${template.label}
优化方向：${template.direction}

请优化下面的图像生成提示词：

${payload.prompt}

请直接输出优化后的提示词正文。`,
    },
  ]
}

export function buildNegativePromptOptimizationMessages(
  payload: NegativePromptOptimizationPayload
): PromptMessage[] {
  const currentNegativePrompt = payload.currentNegativePrompt?.trim()
  return [
    {
      role: 'system',
      content:
        '你是资深 AI 图像生成质量控制专家。你的任务是根据用户的图片描述生成适合放入负面提示词输入框的中文负面约束。最终只输出负面提示词正文，不解释过程，不添加标题，不使用代码块。',
    },
    {
      role: 'user',
      content: `图片描述：
${payload.prompt.trim()}

${currentNegativePrompt ? `用户已有负面提示词：\n${currentNegativePrompt}\n\n` : ''}请生成适合这张图的负面提示词：
1. 输出 12 到 28 个中文短词或短语，用中文逗号分隔。
2. 覆盖通用画质问题、构图/主体错误、材质光影问题、文字水印问题。
3. 结合图片描述中的主体和场景补充专属风险，例如人物、商品、海报、武器、手部、文字、背景等。
4. 不要否定用户明确想要的主体、风格、颜色和文字内容。
5. 不要输出完整句子，不要编号。`,
    },
  ]
}

export function buildCommerceMainPromptSystemInstruction() {
  return '你是资深电商主图视觉导演、商业修图提示词工程师和多模态图像分析师。你的任务是分析商品白底图和目标风格图，然后输出一段可直接用于图像编辑/图像参考生成模型的中文提示词。最终只输出提示词正文，不解释过程，不写 Markdown，不使用代码块。'
}

export function buildCommerceMainPromptUserText(payload: CommerceMainPromptPayload) {
  const description = payload.description.trim() || '用户未填写额外文字描述。'
  const categoryPath = payload.categoryPath?.trim() || '用户未选择商品品类。'
  return `请完成电商主图提示词预处理：

输入说明：
1. 前 ${Math.max(1, payload.productImages.length)} 张图是【商品白底图】，可能包含同一个商品的多个角度，是必须保留的商品主体依据。
2. 最后一张图是【目标风格图】，是构图、背景、光线、色彩、文字布局和商业氛围的参考图。
3. 用户文字描述可能很少，也可能很多；请结合目标风格图进行修剪，只保留适合画面出现或影响视觉表达的信息。

用户文字描述：
${description}

用户选择的商品品类：
${categoryPath}

内部分析要求，不要输出分析过程：
1. 识别目标风格图的构图、主体位置、背景层次、光线方向、材质质感、色彩倾向、摄影/设计风格。
2. 将用户选择的商品品类作为强约束；如果图像识别和品类冲突，优先尊重用户选择的品类，并按该品类常见卖点、材质、使用场景和展示规范组织提示词。
3. 识别目标风格图中可见的文字数量、位置、层级、排版方式和大致用途；如果用户文字描述里有适合替换到画面中的文案，则选择性替换目标风格图的文字；如果用户没有给明确可上图文字，则要求去除/弱化风格图文字，不要编造品牌、价格、参数、二维码。
4. 最终提示词必须明确：综合多张商品白底图理解同一商品的外观、结构和多角度细节，用该商品替换目标风格图里的主商品/主物体，同时保留商品真实外观、结构、颜色、材质、比例和关键细节。
5. 目标风格图只迁移构图、背景、光线、色彩、视觉层级、文字版式和商业质感，不复制风格图中的商品品牌或无关元素。
6. 输出提示词应适合图像编辑模型，强调“参考两张图完成商品替换和风格迁移”。

输出结构必须包含这些段落标题：
【核心任务】
【商品品类】
【商品保持】
【风格迁移】
【文字处理】
【构图光线】
【画质要求】
【负面约束】

总体控制在 450 到 900 个中文字符。`
}

export function buildCommerceDetailPromptSystemInstruction() {
  return '你是资深电商详情页视觉导演、商业修图提示词工程师和多模态图像分析师。你的任务是分析商品白底图和目标详情风格图，然后输出一段可直接用于图像编辑/图像参考生成模型的中文提示词。最终只输出提示词正文，不解释过程，不写 Markdown，不使用代码块。'
}

export function buildCommerceDetailPromptUserText(payload: CommerceDetailPromptPayload) {
  const description = payload.description.trim() || '用户未填写额外文字描述。'
  const categoryPath = payload.categoryPath?.trim() || '用户未选择商品品类。'
  return `请完成电商详情图提示词预处理：

输入说明：
1. 前 ${Math.max(1, payload.productImages.length)} 张图是【商品白底图】，可能包含同一个商品的多个角度，是必须保留的商品主体依据。
2. 最后一张图是【目标详情风格图】，用于参考详情页版式、信息层级、背景质感、细节展示、分屏节奏、文字区域和商业氛围。
3. 用户文字描述可能很少，也可能很多；请结合目标详情风格图进行修剪，拆成适合详情图出现的短卖点、利益点或辅助说明。

用户文字描述：
${description}

用户选择的商品品类：
${categoryPath}

内部分析要求，不要输出分析过程：
1. 识别目标详情风格图的版式结构：主视觉区、卖点标题区、细节特写区、场景/功效说明区、装饰元素和留白比例。
2. 将用户选择的商品品类作为强约束；如果图像识别和品类冲突，优先尊重用户选择的品类，并按该品类常见卖点、材质、使用场景、细节展示和详情页表达规范组织提示词。
3. 识别目标详情风格图中可见文字的数量、层级、位置、字号关系和用途；只用用户描述里的明确文案替换，避免编造品牌、功效、认证、价格、二维码和平台信息。
4. 最终提示词必须明确：综合多张商品白底图理解同一商品外观、包装文字、结构、材质和多角度细节，用该商品替换目标详情风格图里的主商品/局部商品。
5. 目标详情风格图只迁移长图/详情图的排版逻辑、分区节奏、背景、光线、色彩、道具和商业质感，不复制风格图中的商品品牌或无关元素。
6. 输出提示词应适合图像编辑模型，强调“参考两张图完成商品替换、详情页布局迁移和短文案排版”。

输出结构必须包含这些段落标题：
【核心任务】
【商品品类】
【商品保持】
【详情结构】
【卖点文案】
【细节展示】
【风格光线】
【画质要求】
【负面约束】

总体控制在 520 到 980 个中文字符。`
}
