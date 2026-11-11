export function preflightFailure(result) {
  const ping = result?.steps?.find(s => s.op === 'ping');
  const errors = (result?.steps ?? []).map(s => s.error ?? '').join('; ');
  if (/another GUI operation is active/.test(errors)) return {code:'GUI_BUSY', message:'Another GUI job owns the input mutex; inspect its status or deadline.'};
  if (ping?.desktop_available === false) return {code:'DESKTOP_UNAVAILABLE', message:'Interactive desktop unavailable; unlock Windows before live verification.'};
  if (!result?.ok || !ping?.pong) return {code:'BRIDGE_FAILURE', message:errors || result?.error || 'GUI bridge preflight failed.'};
  const windows=result.steps.find(s=>s.op==='ensp')?.windows ?? [];
  if (windows.length !== 1) return {code:'WINDOW_SELECTION_REQUIRED',message:`Expected one open eNSP window; found ${windows.length}.`};
  return null;
}
