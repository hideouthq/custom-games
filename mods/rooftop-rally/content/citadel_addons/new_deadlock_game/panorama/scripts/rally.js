'use strict';

(function () {
  const root = $.GetContextPanel();
  const label = root.FindChildTraverse('RoundLabel');
  const detail = root.FindChildTraverse('RoundDetail');
  const panels = new Map();
  let sweeping = 0;
  const ids = [
    'health_and_abilities_container', 'unit_indicators_v2', 'StatsAndModsContainer', 'crosshair',
    'minimap_persp', 'status_bars', 'ability_resource', 'hud_modifier_history',
    'CitadelHudGameAnnouncements', 'CitadelHudDamageReport', 'hud_damage_summary',
    'hudActivePlayerStats', 'CitadelHudHeroShop', 'hud_hero_testing', 'damage_meter',
    'context_action_container', 'gameplay_hud_dead', 'PregameCountdown',
    'objectives_health_friendly', 'friendly_final_objective_container',
    'enemy_final_objective_container', 'hud_aura_modifiers',
    'hud_replay', 'hudBacker', 'damage_indicator_radar', 'damage_indicator_offscreen_enemy',
    'LowHealthWarning', 'MidHealthWarning', 'low_health_screen_effect',
    'MovementSpeedLabel', 'MovementSpeedCurrent', 'DataFeed', 'spectator_count',
  ];

  function sweep() {
    let top = root;
    while (top.GetParent()) top = top.GetParent();
    ids.forEach(id => {
      let panel = panels.get(id);
      if (!panel || !panel.IsValid()) {
        panel = top.FindChildTraverse(id);
        panels.set(id, panel);
      }
      Modlock.native.style(panel, { visibility: 'collapse', opacity: '0' });
    });
    sweeping = $.Schedule(0.1, sweep);
  }

  Modlock.onUnload(() => $.CancelScheduled(sweeping));
  Modlock.data(value => {
    if (!value || typeof value !== 'object') return;
    label.text = typeof value.title === 'string' ? value.title : '';
    detail.text = typeof value.detail === 'string' ? value.detail : '';
    root.SetHasClass('Targeted', value.targeted === true);
    root.SetHasClass('Spectating', value.spectating === true);
    root.SetHasClass('BallFrozen', value.ballCue === 'frozen');
    root.SetHasClass('BallRestarting', value.ballCue === 'restarting');
    root.SetHasClass('BallResumed', value.ballCue === 'resumed');
  });
  sweep();
})();
