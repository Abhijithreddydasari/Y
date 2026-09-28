from pathlib import Path
import math
import re
import json

from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output' / 'pdf' / 'Y_Product_Thesis_Preread.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
FONT_DIR = Path('C:/Windows/Fonts')
for name, file in [('Sans', 'calibri.ttf'), ('Sans-Bold', 'calibrib.ttf'), ('Sans-Italic', 'calibrii.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
pdfmetrics.registerFontFamily('Sans', normal='Sans', bold='Sans-Bold', italic='Sans-Italic', boldItalic='Sans-Bold')

W, H = A4
M = 44
CW = W - M * 2
INK = HexColor('#202D34')
MUTED = HexColor('#55636A')
ACCENT = HexColor('#9B710F')
GOLD = HexColor('#D5A327')
LINE = HexColor('#D9DFDE')
PALE = HexColor('#FAF6E9')
BLUE = HexColor('#466C76')
RUST = HexColor('#A85338')
c = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
c.setTitle('Y | Product Thesis Pre-Read')
c.setAuthor('Y')
c.setSubject('A whiteboard-led approach to adaptive AI tutoring - pre-read for Activate')
checks = []
page = 1


def para(text, x, top, width, size=10.5, leading=14.3, color=INK, bold=False, align=0):
    style = ParagraphStyle('p', fontName='Sans-Bold' if bold else 'Sans', fontSize=size,
                           leading=leading, textColor=color, alignment=align,
                           spaceBefore=0, spaceAfter=0, splitLongWords=False)
    p = Paragraph(text, style)
    _, height = p.wrap(width, 900)
    p.drawOn(c, x, H - top - height)
    checks.append({'page': page, 'top': round(top, 1), 'bottom': round(top+height, 1), 'text': re.sub('<[^>]+>', '', text)})
    return top + height


def line(x1, top1, x2, top2=None, color=LINE, weight=0.6):
    if top2 is None:
        top2 = top1
    c.setStrokeColor(color)
    c.setLineWidth(weight)
    c.line(x1, H-top1, x2, H-top2)


def label(text, x, top, color=ACCENT, size=8.7):
    return para(text, x, top, CW, size, 11, color, True)


def section(num, title, top):
    label(num, M, top+3)
    bottom = para(title, M+26, top, CW-26, 15.2, 19.5, INK, True)
    return bottom + 9


def furniture(number):
    c.setFillColor(GOLD)
    c.rect(M, H-44, 4, 12, fill=1, stroke=0)
    label('Y  /  PRODUCT THESIS', M+13, 32, INK, 9)
    para('PRE-READ FOR ACTIVATE', W-M-170, 32, 170, 8.7, 11, MUTED, align=2)
    line(M, 57, W-M)
    line(M, 801, W-M)
    para('Y  /  A whiteboard-led approach to adaptive AI tutoring', M, 811, CW-50, 8.5, 11, MUTED)
    para(f'{number} / 2', W-M-40, 811, 40, 8.5, 11, MUTED, align=2)


def arrow(x1, y1, x2, y2, color=GOLD, weight=1.3, head=4):
    line(x1, y1, x2, y2, color, weight)
    a = math.atan2(y2-y1, x2-x1)
    for d in (-0.55, 0.55):
        line(x2, y2, x2-head*math.cos(a+d), y2-head*math.sin(a+d), color, weight)


def loop(top):
    label('THE PROPOSED LEARNING LOOP', M, top)
    gap = 16
    col = (CW-gap*3)/4
    data = [('Student input', 'Write, draw, ask'), ('Shared surface', 'Think together'),
            ('Learner model', 'Track understanding'), ('Adaptive tutor', 'Tailor next step')]
    for i, (name, desc) in enumerate(data):
        x = M+i*(col+gap)
        line(x, top+24, x+col-4, color=GOLD, weight=1)
        para(name, x, top+34, col, bold=True)
        para(desc, x, top+50, col, color=MUTED)
        if i < 3:
            arrow(x+col-1, top+42, x+col+10, top+42, color=ACCENT, weight=0.9, head=3.2)
    return para('Each interaction can refine what the tutor understands and does next.', M, top+77, CW, color=MUTED)


def illustration(top):
    line(M, top, W-M)
    label('WHAT SHARED VISUAL CONTEXT COULD CHANGE', M, top+12)
    para('Illustration, not a live feature', W-M-147, top+12, 147, 8.7, 11, MUTED, align=2)
    x2 = M+CW/2+17
    half = CW/2-17
    para('Text exchange', M, top+35, half, bold=True)
    para('Shared working surface', x2, top+35, half, bold=True)
    line(M+CW/2, top+35, M+CW/2, top+178)
    para('<b>Student</b>  Why does friction point up the slope?', M, top+63, half-7)
    para("<b>Tutor</b>  It opposes the block's tendency to slide.", M, top+99, half-7)

    # Ramp slopes up and right. f is tangent uphill; N is perpendicular to it.
    left = x2+27
    right = x2+181
    bottom = top+155
    ramp_top = top+87
    line(left, bottom, right, bottom, LINE, 0.9)
    line(right, bottom, right, ramp_top, LINE, 0.9)
    line(left, bottom, right, ramp_top, GOLD, 1.8)
    theta = math.atan2(bottom-ramp_top, right-left)
    surface_x = x2+130
    surface_y = bottom-(surface_x-left)*math.tan(theta)
    nx, ny = -math.sin(theta), -math.cos(theta)
    bx, by = surface_x+nx*9, surface_y+ny*9
    c.saveState()
    c.translate(bx, H-by)
    c.rotate(theta*180/math.pi)
    c.setFillColor(PALE)
    c.setStrokeColor(INK)
    c.setLineWidth(1.1)
    c.rect(-12, -9, 24, 18, fill=1, stroke=1)
    c.restoreState()
    arrow(bx, by, bx+nx*40, by+ny*40, BLUE, 1.3)
    arrow(bx, by, bx+math.cos(theta)*44, by-math.sin(theta)*44, ACCENT, 1.3)
    arrow(bx, by, bx, by+42, RUST, 1.3)
    para('N', bx+nx*40-12, by+ny*40-12, 20, color=BLUE)
    para('f', bx+math.cos(theta)*44+5, by-math.sin(theta)*44-8, 20, color=ACCENT)
    para('mg', bx+6, by+32, 24, color=RUST)
    para('Explanation lives in the message thread.', M, top+179, half, color=MUTED)
    end = para('The student and tutor can mark the same diagram.', x2, top+179, half, color=MUTED)
    return end


furniture(1)
para('Why a whiteboard-led AI tutor?', M, 76, CW, 27, 32, INK, True)
para('The case for a shared learning surface that adapts to how students think.', M, 119, CW, 11.5, 16, MUTED)
y = section('01', 'The thesis', 161)
y = para("From classrooms to research labs, some of the best learning happens on a shared surface. <b>Y aims to bring that experience to AI tutoring:</b> a place where students and AI can work through problems together, rather than exchanging answers in isolated chat turns. The longer-term vision combines multimodal tutoring with a self-improving representation of each learner's knowledge and understanding.", M, y, CW)
y = loop(y+21)
y = section('02', 'Why a whiteboard?', y+28)
gap = 20
col = (CW-2*gap)/3
features = [
    ('Active participation', 'Students can attempt, revise and explain their thinking while the tutor responds to their intermediate steps.'),
    ('Visual freedom', 'A shared space supports equations, annotations and diagrams that develop alongside the explanation.'),
    ('Across disciplines', 'The same surface can support math, physics, chemistry, biology, economics and more.')
]
ends = []
for i, (title, body) in enumerate(features):
    x = M+i*(col+gap)
    para(title, x, y, col, bold=True)
    ends.append(para(body, x, y+22, col, color=MUTED))
y = max(ends)+18
line(M, y+1, M, y+31, GOLD, 2)
y = para('<b>The interface is a hypothesis:</b> shared visual context may make multistep, visual problem-solving more effective than chat alone.', M+12, y, CW-12)
y = illustration(y+21)
print('Page 1 ends at', y)
assert y < 786, ('Page 1 overflow', y)
c.showPage()

page = 2
furniture(2)
y = section('03', 'How it compares with other interfaces', 76)
y = para('The goal is not to replace chat or voice. It is to make the right medium available for each task, with a shared visual workspace when the learner needs it.', M, y, CW)
y += 12
comparisons = [
    ('Chat', 'Fast, familiar; less natural for spatial reasoning and joint working.'),
    ('Voice', 'Conversational and hands-free; harder to convey complex visual relationships.'),
    ('Video / diagrams', 'Clear illustrations; typically less interactive than developing them together.'),
    ('Document-grounded AI', 'Keeps teaching within course materials; retrieval alone does not reveal misconceptions.'),
    ('Shared whiteboard', 'Supports joint working, annotations, explanations and student participation.')
]
for title, body in comparisons:
    line(M, y, W-M)
    para(title, M, y+7, 133, color=ACCENT if title=='Shared whiteboard' else INK, bold=True)
    end = para(body, M+145, y+7, CW-145, color=INK if title=='Shared whiteboard' else MUTED)
    y = end+7
line(M, y, W-M)
y = section('04', 'India: tablets today, mobile tomorrow', y+22)
y = para('Many schools already use tablets for learning and assignments, while others are introducing them. This gives a whiteboard-led tutor a natural entry point for students tackling equations and diagrams, especially in JEE/NEET and undergraduate courses. <b>For broader reach, the same tutor should also work on phones without a stylus.</b>', M, y, CW)
y += 12
devices = [('Tablet', 'Write and draw directly'), ('Desktop', 'Use a shared workspace'), ('Phone', 'Chat, voice, photos of work')]
for i, (title, body) in enumerate(devices):
    x = M+i*(col+gap)
    para(title, x, y, col, bold=True)
    end = para(body, x, y+16, col, color=MUTED)
y = end
y = section('05', 'Early exploration and current stage', y+21)
y = para('I briefly explored a retrieval-augmented approach to grounding explanations in external learning material. Uploading notes, slides, textbooks or video references could support syllabus-aware teaching and quizzes. But <b>having the right content is different from understanding the student.</b> The core product question is whether interaction evidence can improve future tutoring.', M, y, CW)
y += 12
stages = [
    ('EXPLORED', 'Lightweight RAG for external course context', 'An initial technical exploration, not a formal form-factor experiment.'),
    ('AVAILABLE NOW', 'Early core tutoring experience', 'The demo supports the initial teaching experience, not the full long-term vision.'),
    ('IN DEVELOPMENT', 'Joint drawing and evolving learner representation', 'The proposed whiteboard interaction and self-improving learning loop are being integrated.')
]
for status, title, body in stages:
    line(M, y, W-M)
    label(status, M, y+8, ACCENT, 8.4)
    t = para(title, M+104, y+6, CW-104, bold=True)
    y = para(body, M+104, t+1, CW-104, color=MUTED)+7
y += 7
y = para('<b>What remains to be proven:</b> whether a whiteboard-led experience improves understanding, participation and continuity over chat or voice alternatives. I have not yet run controlled comparisons.', M, y, CW)
y += 13
label('EARLY DEMO', M, y+1, ACCENT)
para('<link href="https://ask-y-event.vercel.app" color="#202D34"><b>ask-y-event.vercel.app</b></link>', M+82, y, CW-82)
line(M+82, y+14, M+182, color=GOLD, weight=0.7)
print('Page 2 ends at', y+15)
assert y+15 < 787, ('Page 2 overflow', y+15)
c.save()

reader = PdfReader(str(OUT))
assert len(reader.pages) == 2
text = '\n'.join(p.extract_text() for p in reader.pages)
assert '\u2014' not in text, 'Em dash found'
for term in ['The thesis', 'Why a whiteboard?', 'How it compares', 'India:', 'Early exploration', 'controlled comparisons', 'ask-y-event.vercel.app']:
    assert term in text, term
assert len(reader.pages[1].get('/Annots', [])) >= 1, 'Demo link missing'
(ROOT/'tmp'/'pdfs'/'layout_checks.json').write_text(json.dumps(checks, indent=2), encoding='utf-8')
print(OUT)
