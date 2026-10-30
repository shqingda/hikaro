"""Render PTY cell recordings and separately labeled production-component fixtures.
This rasterizes saved terminal cells. It does not verify a macOS terminal's IME
candidate window, native font shaping, or drag selection.
"""
import argparse
import json
import re
import unicodedata
from pathlib import Path
import pyte
from PIL import Image, ImageDraw, ImageFont
base = Path(__file__).parent
parser = argparse.ArgumentParser()
parser.add_argument('--only', choices=['pty', 'matrix', 'both'], default='both')
args = parser.parse_args()
font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16)
bold = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16, index=1)
cjk = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 16)
caption_font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 12)
colors = {'default':'#d7d7ce','black':'#12120f','red':'#d77979','green':'#9db98c','brown':'#f2b500','blue':'#83a5d1','magenta':'#bb98ca','cyan':'#81b8b6','white':'#deded4','brightblack':'#888880','brightwhite':'#ffffff'}
def color(value, default):
    if value == 'default': return default
    if value in colors: return colors[value]
    return '#' + value if len(value)==6 else default

def render(screen, path, label, light=False, cursor=None):
    bg,fg=('#f7f7f6','#12120f') if light else ('#12120f','#d7d7ce')
    cellw,cellh=10,22
    image=Image.new('RGB',(screen.columns*cellw+32,screen.lines*cellh+60),bg)
    draw=ImageDraw.Draw(image)
    draw.text((16,9),label,font=caption_font,fill=fg)
    for y,line in screen.buffer.items():
        for x,char in line.items():
            foreground=color(char.fg,fg);background=color(char.bg,bg)
            if char.reverse: foreground,background=background,foreground
            px,py=x*cellw+16,y*cellh+40
            draw.rectangle((px,py,px+cellw,py+cellh),fill=background)
    # Paint glyphs after all cells so wide CJK characters are not covered by
    # the background of their continuation cell.
    for y,line in screen.buffer.items():
        for x,char in line.items():
            if char.data:
                foreground=color(char.bg,bg) if char.reverse else color(char.fg,fg)
                face=cjk if any(unicodedata.east_asian_width(ch) in 'FW' for ch in char.data) else bold if char.bold else font
                draw.text((x*cellw+16,y*cellh+40),char.data,font=face,fill=foreground)
    if cursor:
        x,y=cursor['x'],cursor['y']
        draw.rectangle((16+x*cellw,40+y*cellh,16+(x+1)*cellw-1,40+(y+1)*cellh-1),outline=fg,width=1)
    image.save(path)

if args.only in ['pty','both']:
    root=base/'pty'
    reports=[]
    for record in json.loads((root/'records.json').read_text()):
        name=record.get('name',f"{record['mode']}-{record['columns']}x{record['rows']}")
        screen=pyte.Screen(record['columns'],record['rows'])
        pyte.Stream(screen).feed((root/(name+'.ansi')).read_text())
        plain='\n'.join(screen.display)
        (root/(name+'.txt')).write_text(plain+'\n')
        cursor={'x':screen.cursor.x,'y':screen.cursor.y} if not screen.cursor.hidden else None
        scenario=record.get('scenario','conversation')
        checks={
            'statusVisible':bool(re.search(r'Ready|Working|Running|Stopped|Waiting|Disconnected',plain)),
            'permissionVisible':any(value in plain for value in ['Permissions','Ask for approval','Workspace write','Managed by Pi']),
            'cursorWithinBounds':cursor is None or (0<=cursor['x']<screen.columns and 0<=cursor['y']<screen.lines),
            'focusedInputCursor':scenario not in ['draft','model'] or cursor is not None,
            'attachmentVisible':scenario not in ['draft','context'] or 'auth.ts' in plain,
            'contextActionVisible':scenario!='context' or 'Remove attachment' in plain,
            'markdownRendered':record['mode']!='embedded-pi' or '**offline demo mode**' not in plain,
        }
        reports.append({**record,'cursor':cursor,'checks':checks,'issues':[key for key,value in checks.items() if not value]})
        render(screen,root/(name+'.png'),f"REAL PTY / {record['mode']} / {screen.columns}x{screen.lines} / {scenario}",cursor=cursor)
    (root/'checks.json').write_text(json.dumps({'captures':len(reports),'failed':[r for r in reports if r['issues']],'results':reports},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'ptyCaptures':len(reports),'failed':[{'name':r.get('name'),'issues':r['issues']} for r in reports if r['issues']]}))
if args.only in ['matrix','both']:
    root=base/'matrix'
    frames=json.loads((root/'frames.json').read_text())['frames']
    for frame in frames:
        screen=pyte.Screen(frame['columns'],frame['rows'])
        stream=pyte.Stream(screen)
        for y,line in enumerate(frame['lines']): stream.feed(f'\x1b[{y+1};1H\x1b[0m'+line)
        render(screen,root/(frame['name']+'.png'),f"COMPONENT FIXTURE / {frame['theme']} / {frame['columns']}x{frame['rows']} / {frame['scenario']}",light=frame['theme']!='dark',cursor=frame['cursor'][0] if frame['cursor'] else None)
    print(json.dumps({'componentFixtures':len(frames),'failed':sum(bool(f['issues']) for f in frames)}))
