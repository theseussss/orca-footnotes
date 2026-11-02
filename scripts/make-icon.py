"""Regenerate the original geometric icon (optional development dependency: Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 500, 500), radius=100, fill="#1d2e49")
for y, end in [(180, 320), (242, 350), (304, 350)]:
    draw.rounded_rectangle((108, y, end, y + 20), radius=10, fill="#e8f0fa")
draw.line([(356, 122), (384, 100), (384, 178)], fill="#8bb9fc", width=18)
draw.line([(357, 178), (408, 178)], fill="#8bb9fc", width=14)
draw.line([(108, 364), (240, 364)], fill="#8bb9fc", width=8)
draw.rounded_rectangle((108, 397, 370, 409), radius=6, fill="#8bb9fc")
image.resize((128, 128), Image.Resampling.LANCZOS).save(Path(__file__).resolve().parents[1] / "icon.png")
