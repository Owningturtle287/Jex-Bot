"""Jex decoder-only transformer. All trainable weights start from scratch."""

from dataclasses import dataclass

import torch
from torch import nn
from torch.nn import functional as F


@dataclass(frozen=True)
class Config:
    vocab_size: int
    context: int
    layers: int
    width: int
    heads: int
    hidden: int

    def __post_init__(self):
        if min(vars(self).values()) <= 0 or self.width % (2 * self.heads):
            raise ValueError("Dimensions must be positive and each head must have even width")


def rotate(x, cos, sin):
    even, odd = x[..., ::2], x[..., 1::2]
    return torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1).flatten(-2)


class Block(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.heads = cfg.heads
        self.attn_norm = nn.RMSNorm(cfg.width, eps=1e-5)
        self.qkv = nn.Linear(cfg.width, 3 * cfg.width, bias=False)
        self.attn_out = nn.Linear(cfg.width, cfg.width, bias=False)
        self.ff_norm = nn.RMSNorm(cfg.width, eps=1e-5)
        self.gate = nn.Linear(cfg.width, cfg.hidden, bias=False)
        self.up = nn.Linear(cfg.width, cfg.hidden, bias=False)
        self.down = nn.Linear(cfg.hidden, cfg.width, bias=False)

    def forward(self, x, cos, sin):
        batch, length, width = x.shape
        q, k, v = self.qkv(self.attn_norm(x)).view(
            batch, length, 3, self.heads, width // self.heads
        ).permute(2, 0, 3, 1, 4).unbind()
        y = F.scaled_dot_product_attention(rotate(q, cos, sin), rotate(k, cos, sin), v, is_causal=True)
        x = x + self.attn_out(y.transpose(1, 2).reshape(batch, length, width))
        y = self.ff_norm(x)
        return x + self.down(F.silu(self.gate(y)) * self.up(y))


class Jex(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.width)
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.layers))
        self.norm = nn.RMSNorm(cfg.width, eps=1e-5)
        head_width = cfg.width // cfg.heads
        freq = 10000 ** (-torch.arange(0, head_width, 2, dtype=torch.float32) / head_width)
        angles = torch.outer(torch.arange(cfg.context), freq)
        self.register_buffer("cos", angles.cos(), persistent=False)
        self.register_buffer("sin", angles.sin(), persistent=False)
        for name, p in self.named_parameters():
            if p.ndim > 1:
                residual = name.endswith(("attn_out.weight", "down.weight"))
                nn.init.normal_(p, std=0.02 / ((2 * cfg.layers) ** 0.5 if residual else 1))

    def forward(self, ids, *, last_only=False):
        length = ids.shape[1]
        if not 0 < length <= self.cfg.context:
            raise ValueError("Input length is outside the context window")
        x = self.embed(ids)
        cos, sin = self.cos[:length], self.sin[:length]
        for block in self.blocks:
            x = block(x, cos, sin)
        return F.linear(self.norm(x[:, -1:] if last_only else x), self.embed.weight)
