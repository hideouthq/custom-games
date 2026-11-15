'use strict';

(function () {
  const root = $.GetContextPanel();
  const meter = root.FindChildTraverse('RallyMeter');
  const figure = root.FindChildTraverse('RallyCount');
  const caption = root.FindChildTraverse('RallyCaption');
  const pips = root.FindChildTraverse('RallyPips');
  const first = 2, step = 5, heats = ['Warm', 'Hot', 'Blazing'];
  let shown = 0, settling = 0;

  Modlock.onUnload(() => $.CancelScheduled(settling));
  Modlock.route('rally', value => {
    if (!meter || !value || typeof value !== 'object') return;
    const count = typeof value.count === 'number' && isFinite(value.count) ? Math.max(0, Math.floor(value.count)) : 0;
    const live = value.live === true;
    root.SetHasClass('ShowRally', count >= first);
    meter.SetHasClass('Broken', !live);
    caption.text = live ? 'RALLY' : 'RALLY OVER';
    if (count >= first) figure.text = String(count);
    const heat = Math.min(heats.length, Math.floor(count / step));
    const lit = count > 0 && count % step === 0 ? step : count % step;
    heats.forEach((name, index) => meter.SetHasClass(name, heat === index + 1));
    for (let i = 0; i < pips.GetChildCount(); i++) pips.GetChild(i).SetHasClass('Lit', i < lit);
    if (count > shown && count >= first) {
      meter.SetHasClass('Pop', true);
      $.CancelScheduled(settling);
      settling = $.Schedule(0.12, () => { if (meter.IsValid()) meter.SetHasClass('Pop', false); });
    }
    shown = count;
  });
})();
