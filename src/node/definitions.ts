import type { ToolSpec } from './types.js';
export const DEFINITIONS: ToolSpec[] = [
  {
    "name": "read_file",
    "description": "读取 UTF-8 文件（含行号和 SHA256）；修改已有文件前必须读取。",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "offset": {
          "type": "integer",
          "minimum": 1
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2000
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_files",
    "description": "按 glob 列出项目文件（默认 **/*；** 递归、* 不跨目录，例如 src/**/*.py）；自动跳过构建产物和 .edacodeignore 指定项。",
    "input_schema": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "search",
    "description": "递归搜索字面文本，返回路径和行号（不是正则表达式）；pattern 是限制范围的 glob。",
    "input_schema": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1
        },
        "pattern": {
          "type": "string"
        },
        "case_sensitive": {
          "type": "boolean"
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "write_file",
    "description": "创建/覆盖 UTF-8 文件；已有文件必须先 read_file；提供 diff、检查读取后是否变化。",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "path",
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "edit_file",
    "description": "精确替换一段文本；默认只允许唯一匹配，多个匹配须明确 all=true。",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "old_text": {
          "type": "string",
          "minLength": 1
        },
        "new_text": {
          "type": "string"
        },
        "all": {
          "type": "boolean"
        }
      },
      "required": [
        "path",
        "old_text",
        "new_text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "shell",
    "description": "运行 Bash 命令，默认 120 秒；background=true 返回 job ID，须用 job_status 等待实际结果。",
    "input_schema": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "minLength": 1
        },
        "timeout": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1800
        },
        "background": {
          "type": "boolean"
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "job_status",
    "description": "读取当前会话命令状态与输出，可等待最多 10 秒。",
    "input_schema": {
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string"
        },
        "wait": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10
        }
      },
      "required": [
        "job_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "cancel_job",
    "description": "终止当前会话的命令进程组。",
    "input_schema": {
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string"
        }
      },
      "required": [
        "job_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "update_plan",
    "description": "设置任务清单及状态；最多一个 in_progress；完成前更新实际进展。",
    "input_schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "object",
            "properties": {
              "step": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "in_progress",
                  "completed"
                ]
              }
            },
            "required": [
              "step",
              "status"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "load_skill",
    "description": "按目录名称读取一份完整 SKILL.md。",
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "read_artifact",
    "description": "分页读取当前会话归档的工具输出或压缩前记录，offset/limit 是字符数。",
    "input_schema": {
      "type": "object",
      "properties": {
        "artifact_id": {
          "type": "string"
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20000
        }
      },
      "required": [
        "artifact_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "delegate",
    "description": "启动独立上下文的只读调查子 agent；可并行多个问题，不能写文件、运行 shell 或再委派。",
    "input_schema": {
      "type": "object",
      "properties": {
        "tasks": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": [
        "tasks"
      ],
      "additionalProperties": false
    }
  }
];
