"""Create clearly labelled, editable PPTX fixtures; never read or overwrite user documents."""
from pathlib import Path
from datetime import datetime, timezone
import os
import sys
from pptx import Presentation
from pptx.util import Inches, Pt

output = Path(sys.argv[1]).resolve()
project_root = Path(__file__).resolve().parent.parent
if project_root not in output.parents:
    raise SystemExit('Refusing to create fixtures outside this project')
output.mkdir(parents=True, exist_ok=True)
fixtures = [
    ('光学课题_报告_旧版.pptx', '光学课题阶段报告（旧版）', '验收样例：光学测量与实验设计。', '2025-01-01T10:00:00+00:00'),
    ('光学课题_报告_新版.pptx', '光学课题阶段报告（新版）', '验收样例：高光谱成像，实验数据与下一步计划。', '2025-01-03T10:00:00+00:00'),
    ('组会资料_验收样例.pptx', '高光谱成像组会', '独特正文线索：偏振光谱仪；光学课题的中期结果。', '2025-01-02T10:00:00+00:00'),
    ('无关预算_验收样例.pptx', '预算安排', '与光学课题报告无关的行政开支示例。', '2025-02-01T10:00:00+00:00'),
]
for filename, title, content, modified in fixtures:
    destination = output / filename
    if destination.exists():
        raise SystemExit(f'Refusing to overwrite an existing file: {destination}')
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    for heading, text in [(title, content), ('仅供资料助手验收', '这是一份自动生成的测试资料，不是真实课题报告。')]:
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        box = slide.shapes.add_textbox(Inches(0.7), Inches(0.6), Inches(11.8), Inches(1))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = heading
        run.font.size = Pt(28)
        box = slide.shapes.add_textbox(Inches(0.7), Inches(2.0), Inches(11.8), Inches(3.5))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = text
        run.font.size = Pt(20)
    presentation.save(destination)
    reopened = Presentation(destination)
    assert len(reopened.slides) == 2
    assert reopened.slides[0].shapes[0].text == title
    instant = datetime.fromisoformat(modified).timestamp()
    os.utime(destination, (instant, instant))
print(f'Created and reopened {len(fixtures)} labelled PPTX fixtures in {output}')
