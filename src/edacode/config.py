"""配置仅在启动时加载，导入模块不会读取密钥或创建文件。"""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass
class Config:
    workspace: Path
    home: Path
    provider: str = "anthropic"
    model: str = ""
    api_key: str = ""
    base_url: str | None = None
    mode: str = "edit"
    max_turns: int = 40
    max_stop_blocks: int = 5
    max_tokens: int = 8192
    context_chars: int = 120000
    timeout: int = 120
    stream: bool = True

    def validate(self):
        self.workspace = self.workspace.expanduser().resolve()
        self.home = self.home.expanduser().resolve()
        if not self.workspace.is_dir():
            raise ValueError(f"工作目录不存在：{self.workspace}")
        if self.provider not in {"anthropic", "openai", "mock"}:
            raise ValueError("provider 必须是 anthropic/openai/mock")
        if self.mode not in {"plan", "ask", "edit", "auto"}:
            raise ValueError("mode 必须是 plan/ask/edit/auto")
        for name in ("max_turns", "max_stop_blocks", "max_tokens", "context_chars", "timeout"):
            if type(getattr(self, name)) is not int or getattr(self, name) <= 0:
                raise ValueError(f"{name} 必须为正整数")
        if self.context_chars < 8000:
            raise ValueError("context_chars 不能小于 8000")
        if self.provider != "mock" and (not self.model or not self.api_key):
            raise ValueError("缺少模型或 API key；请配置 .env，或使用 --provider mock 离线体验")
        return self


def load_config(args) -> Config:
    workspace = Path(args.workspace).expanduser().resolve()
    from dotenv import load_dotenv
    env_file = Path(args.env_file).expanduser() if args.env_file else workspace / ".env"
    if args.env_file and not env_file.is_file():
        raise ValueError(f"env 文件不存在：{env_file}")
    load_dotenv(env_file, override=False)
    provider = args.provider or os.getenv("EDACODE_PROVIDER", "anthropic")
    prefix = "OPENAI" if provider == "openai" else "ANTHROPIC"
    return Config(
        workspace=workspace,
        home=Path(args.home or os.getenv("EDACODE_HOME", "~/.edacode")),
        provider=provider,
        model=args.model or os.getenv("EDACODE_MODEL") or os.getenv("MODEL_ID", ""),
        api_key=os.getenv(f"{prefix}_API_KEY", ""),
        base_url=os.getenv(f"{prefix}_BASE_URL") or None,
        mode=args.mode or os.getenv("EDACODE_MODE", "edit"),
        max_turns=args.max_turns if args.max_turns is not None else int(os.getenv("EDACODE_MAX_TURNS", "40")),
        max_stop_blocks=int(os.getenv("EDACODE_MAX_STOP_BLOCKS", "5")),
        max_tokens=int(os.getenv("EDACODE_MAX_TOKENS", "8192")),
        context_chars=int(os.getenv("EDACODE_CONTEXT_CHARS", "120000")),
        timeout=int(os.getenv("EDACODE_TIMEOUT", "120")),
        stream=not args.no_stream,
    ).validate()
