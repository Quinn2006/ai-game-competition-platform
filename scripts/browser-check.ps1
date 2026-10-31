$ErrorActionPreference = 'Stop'
$session = 'phase0-codex-project1'
function Invoke-Browser {
    & agent-browser --session $session @args
    if ($LASTEXITCODE -ne 0) { throw "Browser command failed: $args" }
}
Invoke-Browser open 'http://127.0.0.1:4310'
Invoke-Browser wait --fn 'Object.keys(window.phase0.reports).length === 2'
Invoke-Browser click '#reload'
Invoke-Browser wait --fn 'Object.keys(window.phase0.reports).length === 2'
$check = @'
(() => {
  const reports = Object.entries(window.phase0.reports);
  if (reports.length !== 2) throw Error('Expected two works');
  for (const [origin, r] of reports) {
    for (const key of ['parentStorage','parentCookie','siblingStorage']) {
      if (r[key] !== 'SecurityError') throw Error(origin + ':' + key);
    }
    if (r.ownCookie !== '' || r.fetch !== 'TypeError' || r.externalFetch !== 'TypeError') throw Error('Network or cookie failure');
    if (r.saveOwner !== origin || r.previousOwner !== origin || r.visits < 2) throw Error('Save isolation/persistence failure');
  }
  if (window.phase0.rejected < 4) throw Error('Forged messages accepted');
  return {status:'PASS', userAgent:navigator.userAgent, reports:window.phase0.reports, rejected:window.phase0.rejected};
})()
'@
Invoke-Browser eval $check
Invoke-Browser set viewport 1280 900
Invoke-Browser screenshot 'preview/phase0-desktop.png'
Invoke-Browser set viewport 390 844
Invoke-Browser eval '(() => { if(document.documentElement.scrollWidth > innerWidth) throw Error("Horizontal overflow"); return "PASS: mobile width"; })()'
Invoke-Browser screenshot 'preview/phase0-mobile.png'
Invoke-Browser errors
