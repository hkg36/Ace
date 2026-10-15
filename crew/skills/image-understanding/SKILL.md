---
name: image-understanding
description: 使用用户配置的 OpenAI 兼容视觉模型分析本地图片。适用于描述图片、识别图片内容、回答图片相关问题，也为 Crew LLM Wiki 的图片材料解析提供能力。
metadata:
  skillCategoryName: 图像处理
  version: 1.0.0
  crew:
    emoji: 🖼️
    requires:
      bins: [python3]
  zh_name: 图片理解
  zh_description: 使用用户配置的 OpenAI 兼容视觉模型分析本地图片，并支持 Crew LLM Wiki 图片材料解析。
  query_examples:
    - 这张图片里有什么？
    - 帮我描述一下这张图片
    - 分析这张图片的内容
python: ">=3.8"
---

# 图片理解

本 Skill 使用模型配置中启用了“音视频处理”能力的模型分析单张本地图片。模型服务地址、名称和 API Key 均来自软件内的模型配置。

## 配置

在模型配置页面为支持图像输入的模型填写服务地址、模型名称和 API Key，并勾选“音视频处理”。未勾选该能力的模型不会用于此 Skill。接口需兼容 `POST /chat/completions`，并支持消息中的 `image_url` data URL。

## 使用

```bash
python scripts/image_understand.py /path/to/image.png
python scripts/image_understand.py /path/to/image.png --prompt "图片中的表格有哪些数据？"
```

支持 `jpg`、`jpeg`、`png`、`webp`、`bmp`、`gif`，单个文件上限 10 MB。图片内容会发送到用户配置的模型服务，请先确认该服务满足数据安全要求。
