"""
create_sections_db.py
Generates sections_db.xlsx with Steel (W-shapes, IPE, HEA), Concrete, and Timber
section databases for the Structural Analyser app.

Column units:
  E_GPa      Young's modulus [GPa]
  A_cm2      Cross-section area [cm²]
  I_cm4      Strong-axis second moment of area [cm⁴]
  fy_MPa     Yield / characteristic strength [MPa]
  rho_kNm3   Unit weight [kN/m³]
  b_mm       Width [mm]
  h_mm       Height / depth [mm]
  Description  Free-text note
"""

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = openpyxl.Workbook()

# ── helpers ──────────────────────────────────────────────────────────────────
HEADER_FILL  = PatternFill("solid", fgColor="1565C0")
ALT_FILL     = PatternFill("solid", fgColor="E3F0FF")
HEADER_FONT  = Font(bold=True, color="FFFFFF", size=11)
NORMAL_FONT  = Font(size=10)
THIN         = Side(style="thin", color="AAAAAA")
BORDER       = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
COLS = ["Name","E_GPa","A_cm2","I_cm4","fy_MPa","rho_kNm3","b_mm","h_mm","Description"]
COL_WIDTHS = [22, 8, 10, 12, 9, 10, 8, 8, 40]

def write_sheet(ws, rows, sheet_title):
    ws.title = sheet_title
    # Header row
    for ci, (col, w) in enumerate(zip(COLS, COL_WIDTHS), 1):
        cell = ws.cell(1, ci, col)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        cell.border = BORDER
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[1].height = 18
    # Data rows
    for ri, row in enumerate(rows, 2):
        fill = ALT_FILL if ri % 2 == 0 else PatternFill()
        for ci, val in enumerate(row, 1):
            cell = ws.cell(ri, ci, val)
            cell.font = NORMAL_FONT
            cell.fill = fill
            cell.border = BORDER
            if ci > 1 and isinstance(val, (int, float)):
                cell.number_format = "0.0##"
    ws.freeze_panes = "A2"

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 1 — AISC W-Shapes (Steel)
# A [cm²], I [cm⁴], E=200 GPa, fy=345 MPa (A992), rho=78.5 kN/m³
# ─────────────────────────────────────────────────────────────────────────────
W_shapes = [
    # Name           E     A       I          fy    rho   bf    d    Description
    ("W4×13",       200,  24.7,   8.45e3,    345,  78.5, 102,  106, "AISC W4x13"),
    ("W5×16",       200,  30.3,   17.4e3,    345,  78.5, 128,  127, "AISC W5x16"),
    ("W6×15",       200,  28.5,   24.1e3,    345,  78.5, 152,  152, "AISC W6x15"),
    ("W6×20",       200,  37.9,   31.8e3,    345,  78.5, 152,  157, "AISC W6x20"),
    ("W8×24",       200,  45.5,   65.6e3,    345,  78.5, 165,  201, "AISC W8x24"),
    ("W8×31",       200,  58.7,   85.3e3,    345,  78.5, 203,  203, "AISC W8x31"),
    ("W8×40",       200,  75.5,   107e3,     345,  78.5, 205,  210, "AISC W8x40"),
    ("W10×33",      200,  62.6,   170e3,     345,  78.5, 201,  247, "AISC W10x33"),
    ("W10×45",      200,  85.2,   225e3,     345,  78.5, 203,  257, "AISC W10x45"),
    ("W10×60",      200,  114,    305e3,     345,  78.5, 209,  269, "AISC W10x60"),
    ("W12×40",      200,  75.5,   305e3,     345,  78.5, 203,  303, "AISC W12x40"),
    ("W12×53",      200,  100,    399e3,     345,  78.5, 254,  306, "AISC W12x53"),
    ("W12×72",      200,  136,    530e3,     345,  78.5, 254,  318, "AISC W12x72"),
    ("W14×48",      200,  90.9,   560e3,     345,  78.5, 203,  351, "AISC W14x48"),
    ("W14×68",      200,  129,    723e3,     345,  78.5, 254,  356, "AISC W14x68"),
    ("W14×90",      200,  170,    933e3,     345,  78.5, 356,  356, "AISC W14x90 (column)"),
    ("W14×132",     200,  250,    1330e3,    345,  78.5, 374,  373, "AISC W14x132 (column)"),
    ("W16×57",      200,  108,    790e3,     345,  78.5, 206,  403, "AISC W16x57"),
    ("W18×65",      200,  123,   1140e3,     345,  78.5, 211,  455, "AISC W18x65"),
    ("W18×86",      200,  163,   1440e3,     345,  78.5, 216,  467, "AISC W18x86"),
    ("W21×73",      200,  139,   1870e3,     345,  78.5, 215,  533, "AISC W21x73"),
    ("W21×101",     200,  192,   2520e3,     345,  78.5, 216,  549, "AISC W21x101"),
    ("W24×76",      200,  144,   2830e3,     345,  78.5, 225,  599, "AISC W24x76"),
    ("W24×84",      200,  160,   3050e3,     345,  78.5, 229,  602, "AISC W24x84"),
    ("W27×94",      200,  178,   4580e3,     345,  78.5, 254,  678, "AISC W27x94"),
    ("W30×108",     200,  205,   7210e3,     345,  78.5, 267,  757, "AISC W30x108"),
    ("W33×118",     200,  224,   9980e3,     345,  78.5, 292,  838, "AISC W33x118"),
    ("W36×135",     200,  257,  14100e3,     345,  78.5, 305,  912, "AISC W36x135"),
]
ws1 = wb.active
write_sheet(ws1, W_shapes, "Steel_W")

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 2 — European IPE Sections
# ─────────────────────────────────────────────────────────────────────────────
IPE_sections = [
    # Name       E     A      I       fy    rho    bf   d    Description
    ("IPE 80",  210,  7.64,   80.1,  235,  78.5,  46,  80,  "EN 10025 S235"),
    ("IPE 100", 210,  10.3,  171,    235,  78.5,  55, 100,  "EN 10025 S235"),
    ("IPE 120", 210,  13.2,  318,    235,  78.5,  64, 120,  "EN 10025 S235"),
    ("IPE 140", 210,  16.4,  541,    235,  78.5,  73, 140,  "EN 10025 S235"),
    ("IPE 160", 210,  20.1,  869,    235,  78.5,  82, 160,  "EN 10025 S235"),
    ("IPE 180", 210,  23.9, 1317,    235,  78.5,  91, 180,  "EN 10025 S235"),
    ("IPE 200", 210,  28.5, 1943,    235,  78.5, 100, 200,  "EN 10025 S235"),
    ("IPE 220", 210,  33.4, 2772,    235,  78.5, 110, 220,  "EN 10025 S235"),
    ("IPE 240", 210,  39.1, 3892,    235,  78.5, 120, 240,  "EN 10025 S235"),
    ("IPE 270", 210,  45.9, 5790,    235,  78.5, 135, 270,  "EN 10025 S235"),
    ("IPE 300", 210,  53.8, 8356,    235,  78.5, 150, 300,  "EN 10025 S235"),
    ("IPE 330", 210,  62.6,11770,    235,  78.5, 160, 330,  "EN 10025 S235"),
    ("IPE 360", 210,  72.7,16270,    235,  78.5, 170, 360,  "EN 10025 S235"),
    ("IPE 400", 210,  84.5,23130,    235,  78.5, 180, 400,  "EN 10025 S235"),
    ("IPE 450", 210,  98.8,33740,    235,  78.5, 190, 450,  "EN 10025 S235"),
    ("IPE 500", 210, 116,  48200,    235,  78.5, 200, 500,  "EN 10025 S235"),
    ("IPE 550", 210, 134,  67120,    235,  78.5, 210, 550,  "EN 10025 S235"),
    ("IPE 600", 210, 156,  92080,    235,  78.5, 220, 600,  "EN 10025 S235"),
]
ws2 = wb.create_sheet()
write_sheet(ws2, IPE_sections, "Steel_IPE")

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 3 — European HEA Sections
# ─────────────────────────────────────────────────────────────────────────────
HEA_sections = [
    ("HEA 100", 210,  21.2,  349,   235, 78.5, 100,  96, "EN 10025 S235"),
    ("HEA 120", 210,  25.3,  606,   235, 78.5, 120, 114, "EN 10025 S235"),
    ("HEA 140", 210,  31.4, 1033,   235, 78.5, 140, 133, "EN 10025 S235"),
    ("HEA 160", 210,  38.8, 1673,   235, 78.5, 160, 152, "EN 10025 S235"),
    ("HEA 180", 210,  45.3, 2510,   235, 78.5, 180, 171, "EN 10025 S235"),
    ("HEA 200", 210,  53.8, 3692,   235, 78.5, 200, 190, "EN 10025 S235"),
    ("HEA 220", 210,  64.3, 5410,   235, 78.5, 220, 210, "EN 10025 S235"),
    ("HEA 240", 210,  76.8, 7763,   235, 78.5, 240, 230, "EN 10025 S235"),
    ("HEA 260", 210,  86.8,10450,   235, 78.5, 260, 250, "EN 10025 S235"),
    ("HEA 280", 210,  97.3,13670,   235, 78.5, 280, 270, "EN 10025 S235"),
    ("HEA 300", 210, 113,  18260,   235, 78.5, 300, 290, "EN 10025 S235"),
    ("HEA 320", 210, 124,  22930,   235, 78.5, 300, 310, "EN 10025 S235"),
    ("HEA 340", 210, 133,  27690,   235, 78.5, 300, 330, "EN 10025 S235"),
    ("HEA 360", 210, 143,  33090,   235, 78.5, 300, 350, "EN 10025 S235"),
    ("HEA 400", 210, 159,  45070,   235, 78.5, 300, 390, "EN 10025 S235"),
    ("HEA 450", 210, 178,  63720,   235, 78.5, 300, 440, "EN 10025 S235"),
    ("HEA 500", 210, 198,  86970,   235, 78.5, 300, 490, "EN 10025 S235"),
    ("HEB 100", 210,  26.0,  449,   235, 78.5, 100, 100, "EN 10025 S235 HEB"),
    ("HEB 120", 210,  34.0,  864,   235, 78.5, 120, 120, "EN 10025 S235 HEB"),
    ("HEB 140", 210,  43.0, 1509,   235, 78.5, 140, 140, "EN 10025 S235 HEB"),
    ("HEB 160", 210,  54.3, 2492,   235, 78.5, 160, 160, "EN 10025 S235 HEB"),
    ("HEB 180", 210,  65.3, 3831,   235, 78.5, 180, 180, "EN 10025 S235 HEB"),
    ("HEB 200", 210,  78.1, 5696,   235, 78.5, 200, 200, "EN 10025 S235 HEB"),
    ("HEB 220", 210,  91.0, 8091,   235, 78.5, 220, 220, "EN 10025 S235 HEB"),
    ("HEB 240", 210, 106,  11260,   235, 78.5, 240, 240, "EN 10025 S235 HEB"),
    ("HEB 260", 210, 118,  14920,   235, 78.5, 260, 260, "EN 10025 S235 HEB"),
    ("HEB 280", 210, 131,  19270,   235, 78.5, 280, 280, "EN 10025 S235 HEB"),
    ("HEB 300", 210, 149,  25170,   235, 78.5, 300, 300, "EN 10025 S235 HEB"),
]
ws3 = wb.create_sheet()
write_sheet(ws3, HEA_sections, "Steel_HEA_HEB")

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 4 — Rectangular Concrete Sections
# E = 25 GPa (f'c ≈ 4000 psi normal weight), fy = 27.6 MPa (f'c)
# ─────────────────────────────────────────────────────────────────────────────
def rect(b_mm, h_mm, E=25, fy=27.6, rho=23.6):
    b = b_mm / 10  # mm → cm
    h = h_mm / 10
    A = b * h
    I = b * h**3 / 12
    return (f"Conc {b_mm}×{h_mm}mm", E, round(A,1), round(I,0), fy, rho, b_mm, h_mm,
            f"Rectangular {b_mm}mm×{h_mm}mm, f'c=27.6 MPa")

conc_sections = [
    # Inch-based sizes (converted to mm)
    ("Conc 9\"×9\"",   25, 522.6, 22754,  27.6, 23.6,  229, 229, "9in × 9in — ACI default"),
    ("Conc 12\"×12\"", 25, 930.3, 72130,  27.6, 23.6,  305, 305, "12in × 12in column"),
    ("Conc 12\"×18\"", 25, 1393,  242000, 27.6, 23.6,  305, 457, "12in × 18in beam"),
    ("Conc 12\"×24\"", 25, 1858,  576000, 27.6, 23.6,  305, 610, "12in × 24in deep beam"),
    ("Conc 16\"×16\"", 25, 1650,  228000, 27.6, 23.6,  406, 406, "16in × 16in column"),
    ("Conc 16\"×24\"", 25, 2477,  770000, 27.6, 23.6,  406, 610, "16in × 24in beam"),
    ("Conc 18\"×18\"", 25, 2090,  363000, 27.6, 23.6,  457, 457, "18in × 18in column"),
    ("Conc 20\"×20\"", 25, 2581,  559000, 27.6, 23.6,  508, 508, "20in × 20in column"),
    ("Conc 24\"×24\"", 25, 3716, 1157000, 27.6, 23.6,  610, 610, "24in × 24in column"),
    # Metric-based sizes
    rect(200,300), rect(250,400), rect(300,500), rect(300,600),
    rect(350,600), rect(400,600), rect(400,700), rect(400,800),
    rect(500,800), rect(500,1000), rect(600,1200),
]
ws4 = wb.create_sheet()
write_sheet(ws4, conc_sections, "Concrete_Rect")

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 5 — Timber Sections (North American sawn lumber)
# E = 12 GPa (Douglas Fir-Larch No.1), fy = 8.3 MPa (Fb bending)
# Actual (dressed) dimensions used
# ─────────────────────────────────────────────────────────────────────────────
def timber(b_mm, h_mm, E=12.0, fy=8.3, rho=5.5, label=None):
    b = b_mm / 10
    h = h_mm / 10
    A = b * h
    I = b * h**3 / 12
    name = label if label else f"Timber {b_mm}×{h_mm}mm"
    desc = f"Sawn lumber {b_mm}mm×{h_mm}mm, E=12 GPa, Fb=8.3 MPa"
    return (name, E, round(A,2), round(I,2), fy, rho, b_mm, h_mm, desc)

timber_sections = [
    timber(38,  89,  label='2"×4" (38×89)'),
    timber(38, 140,  label='2"×6" (38×140)'),
    timber(38, 184,  label='2"×8" (38×184)'),
    timber(38, 235,  label='2"×10" (38×235)'),
    timber(38, 286,  label='2"×12" (38×286)'),
    timber(64, 140,  label='3"×6" (64×140)'),
    timber(89,  89,  label='4"×4" (89×89)'),
    timber(89, 140,  label='4"×6" (89×140)'),
    timber(89, 184,  label='4"×8" (89×184)'),
    timber(89, 235,  label='4"×10" (89×235)'),
    timber(89, 286,  label='4"×12" (89×286)'),
    timber(140, 140, label='6"×6" (140×140)'),
    timber(140, 184, label='6"×8" (140×184)'),
    timber(140, 235, label='6"×10" (140×235)'),
    timber(140, 286, label='6"×12" (140×286)'),
    timber(184, 184, label='8"×8" (184×184)'),
    timber(184, 235, label='8"×10" (184×235)'),
    timber(184, 286, label='8"×12" (184×286)'),
    timber(235, 235, label='10"×10" (235×235)'),
    timber(286, 286, label='12"×12" (286×286)'),
    # Glulam
    ("Glulam 130×270", 12.5, 351.0,  2127,  9.5, 5.5, 130, 270, "GLT 130×270mm, E=12.5 GPa"),
    ("Glulam 165×270", 12.5, 445.5,  2693,  9.5, 5.5, 165, 270, "GLT 165×270mm, E=12.5 GPa"),
    ("Glulam 165×360", 12.5, 594.0,  6415,  9.5, 5.5, 165, 360, "GLT 165×360mm, E=12.5 GPa"),
    ("Glulam 215×360", 12.5, 774.0,  8361,  9.5, 5.5, 215, 360, "GLT 215×360mm, E=12.5 GPa"),
    ("Glulam 215×495", 12.5,1064.0, 21800,  9.5, 5.5, 215, 495, "GLT 215×495mm, E=12.5 GPa"),
]
ws5 = wb.create_sheet()
write_sheet(ws5, timber_sections, "Timber_Rect")

# ─────────────────────────────────────────────────────────────────────────────
# Sheet 6 — README / How to Use
# ─────────────────────────────────────────────────────────────────────────────
ws6 = wb.create_sheet("README")
ws6.column_dimensions["A"].width = 70
notes = [
    ("STRUCTURAL ANALYSER — Section Database", True),
    ("", False),
    ("HOW TO USE:", True),
    ("1. Open the app and go to the 'Sects' tab in the right panel.", False),
    ("2. Click '📥 Import DB' and select this file (sections_db.xlsx).", False),
    ("3. All sheets will be loaded automatically.", False),
    ("4. You can also export your current sections as CSV and re-import later.", False),
    ("", False),
    ("COLUMN DEFINITIONS:", True),
    ("  Name      — Section identifier (must be unique)", False),
    ("  E_GPa     — Young's modulus [GPa]  (Steel≈200–210, Concrete≈25–35, Timber≈9–13)", False),
    ("  A_cm2     — Cross-sectional area [cm²]", False),
    ("  I_cm4     — Strong-axis second moment of area [cm⁴]", False),
    ("  fy_MPa    — Steel: yield strength [MPa]; Concrete: f'c [MPa]; Timber: Fb [MPa]", False),
    ("  rho_kNm3  — Unit weight [kN/m³]  (Steel=78.5, Concrete=23.6, Timber=5.5)", False),
    ("  b_mm      — Width [mm] (informational)", False),
    ("  h_mm      — Depth/Height [mm] (informational)", False),
    ("  Description — Free text", False),
    ("", False),
    ("SHEETS:", True),
    ("  Steel_W        — AISC W-shapes (A992 Gr. 65, Fy=345 MPa)", False),
    ("  Steel_IPE      — European IPE I-beams (S235)", False),
    ("  Steel_HEA_HEB  — European H-sections (S235)", False),
    ("  Concrete_Rect  — Rectangular RC sections (f'c=27.6 MPa / 4000 psi)", False),
    ("  Timber_Rect    — Sawn lumber & glulam (Douglas Fir / GLT)", False),
]
for ri, (text, bold) in enumerate(notes, 1):
    c = ws6.cell(ri, 1, text)
    c.font = Font(bold=bold, size=11 if bold else 10)
    if bold:
        c.fill = PatternFill("solid", fgColor="E8F0FE")

# ─────────────────────────────────────────────────────────────────────────────
out = r"C:\Users\Haseeb\Desktop\#\sections_db.xlsx"
wb.save(out)
print(f"Saved: {out}")
print(f"  Steel W-shapes : {len(W_shapes)} sections")
print(f"  Steel IPE      : {len(IPE_sections)} sections")
print(f"  Steel HEA/HEB  : {len(HEA_sections)} sections")
print(f"  Concrete Rect  : {len(conc_sections)} sections")
print(f"  Timber         : {len(timber_sections)} sections")
