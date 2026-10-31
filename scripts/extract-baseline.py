"""Offline OOXML text extraction; originals remain authoritative."""
from pathlib import Path
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET

SOURCE = Path(r'C:\Users\wkq17\Documents\Codex\2026-10-31\referenced-chatgpt-conversation-this-is-an\outputs')
OUT = Path('docs/phase-0/sources')
OUT.mkdir(parents=True, exist_ok=True)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
manifest, requirements, decisions = [], [], []
for path in sorted(SOURCE.glob('*v1.1.docx')):
    with zipfile.ZipFile(path) as archive:
        tree = ET.fromstring(archive.read('word/document.xml'))
    lines = []
    for node in tree.findall('.//w:body/*', ns):
        if node.tag.endswith('}tbl'):
            for row in node.findall('w:tr', ns):
                cells = [''.join(t.text or '' for t in c.findall('.//w:t', ns)) for c in row.findall('w:tc', ns)]
                lines.append(' | '.join(cells))
                if path.name.startswith('附录') and re.fullmatch(r'(D\d+|DF|S)-\d{2}', cells[0]):
                    requirements.append({'id': cells[0], 'topic': cells[1], 'rule': cells[2] if not cells[0].startswith('S-') else cells[1]})
                if path.name.startswith('附录') and re.match(r'T-\d{2}', cells[0]):
                    decisions.append({'id': cells[0][:4], 'question': cells[1], 'impact': cells[3]})
        else:
            line = ''.join(t.text or '' for t in node.findall('.//w:t', ns))
            lines.append(line)
            match = re.match(r'(B-\d{2}) (.+?)：(.+)', line)
            if path.name.startswith('附录') and match:
                requirements.append(dict(zip(['id', 'topic', 'rule'], match.groups())))
    (OUT / (path.stem + '.md')).write_text('\n\n'.join(lines).rstrip() + '\n', encoding='utf-8')
    manifest.append({'source': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'paragraphs_and_rows': len(lines), 'method': 'Python stdlib zipfile + ElementTree; body paragraphs and table cells; no images/headers/rendering'})
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
Path('docs/phase-0/requirements.json').write_text(json.dumps(requirements, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
Path('docs/phase-0/decisions-source.json').write_text(json.dumps(decisions, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Extracted {len(manifest)} documents, {len(requirements)} requirements, {len(decisions)} decisions')
