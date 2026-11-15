'use strict';
(function () {
  let root = $.GetContextPanel();
  while (root.GetParent()) root = root.GetParent();
  const tooltip = Modlock.native.group();
  let view = null;
  let anchor = null;
  let polling = 0;

  function property(panel, value, base) {
    if (!panel) return;
    panel.FindChildrenWithClassTraverse('CurrentValue').forEach(function (label) { tooltip.relabel(label, value, ['CurrentValue']); });
    panel.FindChildrenWithClassTraverse('BaseValue').forEach(function (label) { tooltip.relabel(label, base, ['BaseValue', 'AltStateVisible']); });
    tooltip.relabel(panel.FindChildTraverse('BaseLabel'), value);
    tooltip.relabel(panel.FindChildTraverse('ModifiedLabel'), value);
  }
  function apply() {
    root.FindChildrenWithClassTraverse('TooltipVisible').filter(function (panel) { return panel.paneltype === 'CitadelTooltipAbilityDetails'; }).forEach(function (panel) {
      const details = panel.FindChildTraverse('AbilityDetailsPanel');
      if (!details) return;
      details.FindChildrenWithClassTraverse('AbilityName').forEach(function (label) { tooltip.relabel(label, 'Hook', ['AbilityName']); });
      tooltip.relabel(details.FindChildTraverse('AbilityDescription'), 'Pull an enemy onto your bank and deal 55% of their maximum health before resistance. Fight with melee or Hook again to finish them. Hook allies back to safety.', ['PropertiesBlockHeaderLabel']);
      const damage = details.FindChildTraverse('AbilityProperty_Damage');
      property(damage, '55%', '55%');
      if (damage) tooltip.hide(damage.FindChildTraverse('ScalingStatLabel'));
      property(details.FindChildTraverse('AbilityProperty_AbilityCastRange'), view.range + 'm', '30m');
      property(details.FindChildTraverse('AbilityCastRange'), view.range + 'm', '30m');
      property(details.FindChildTraverse('AbilityCooldown'), view.cooldown + 's', '5s');
      const list = panel.FindChildTraverse('AbilityUpgradeList');
      const tiers = ['+6m Hook range (36m total)', '−1s Hook cooldown (4s total)', 'Rebound: enemy Hook hits refund 1s of cooldown'];
      if (list) for (let i = 0; i < Math.min(3, list.GetChildCount()); i++) {
        const tier = list.GetChild(i);
        tooltip.relabel(tier.FindChildTraverse('upgradeDesc'), tiers[i]);
        tier.FindChildrenWithClassTraverse('upgradeBonusAmount').forEach(function (label) { tooltip.hide(label); });
      }
    });
  }
  // Hover is read, not bound: replacing the slot's native handlers would leave them broken after the mode.
  function hovered(panel) {
    for (let i = 0; i < panel.GetChildCount(); i++) {
      const found = hovered(panel.GetChild(i));
      if (found) return found;
    }
    return panel.BHasHoverStyle() ? panel : null;
  }
  function leave() {
    if (!anchor) return;
    $.DispatchEvent('CitadelHideAbilityDetailsTooltip', anchor);
    anchor = null;
    tooltip.release();
  }
  function poll() {
    const abilities = root.FindChildTraverse('hud_signature');
    if (abilities) ['slot_signature_1', 'slot_signature_2', 'slot_signature_4'].forEach(function (id) { Modlock.native.hide(abilities.FindChildTraverse(id)); });
    const slot = abilities && abilities.FindChildTraverse('slot_signature_3');
    const target = slot && view && view.slot >= 0 ? hovered(slot) : null;
    if (target !== anchor) {
      leave();
      if (target) {
        anchor = target;
        $.DispatchEvent('CitadelShowAbilityDetailsTooltip', anchor, view.hookId, view.slot);
      }
    }
    if (anchor) apply();
    polling = $.Schedule(0.1, poll);
  }
  Modlock.data(function (data) { view = data; });
  Modlock.onUnload(function () {
    $.CancelScheduled(polling);
    leave();
  });
  poll();
})();
