'use strict';

(function () {
  const root = $.GetContextPanel();
  const cards = root.FindChildTraverse('AbilityCards');
  const ability = root.FindChildTraverse('RallyAbility');
  let choices = null;
  let special = null;
  let built = false;
  let source = null;
  let revision = 0;
  let stopped = false;
  let hydration = 0;
  let description = null;
  const tooltip = Modlock.native.group();

  function command(text) { $.DispatchEvent('CitadelConCommand', text); }
  function selected() { return choices && special && choices.choices.find(choice => choice.id === special.choice); }
  function label(id, text) { root.FindChildTraverse(id).text = text; }
  function createCards() {
    const textures = { isWeapon: 'weapon', isTech: 'spirit', isArmor: 'vitality' };
    choices.choices.forEach(choice => {
      const button = $.CreatePanel('Button', cards, 'Choose_' + choice.id);
      button.AddClass('ChoiceCardButton');
      button.AddClass(choice.category);
      button.hittestchildren = false;
      const texture = textures[choice.category];
      const paper = $.CreatePanel('Image', button, 'CardPaper', { scaling: 'stretch-to-fit' });
      paper.SetImage('s2r://panorama/images/shop/catalog/cards/card_backer_' + texture + '_t1_psd.vtex');
      const content = $.CreatePanel('Panel', button, 'CardContent');
      const heading = $.CreatePanel('Panel', content, 'ChoiceHeading');
      const header = $.CreatePanel('Image', heading, 'CardHeader', { scaling: 'stretch-to-fit' });
      header.SetImage('s2r://panorama/images/shop/catalog/catalog_tooltip_header_' + texture + '_psd.vtex');
      const art = $.CreatePanel('Image', heading, 'RallyCardArt', { scaling: 'stretch-to-fit-preserve-aspect' });
      art.SetImage(choice.icon);
      const name = $.CreatePanel('Label', heading, 'ChoiceName');
      name.text = choice.name;
      const cooldown = $.CreatePanel('Label', heading, 'ChoiceCooldown');
      cooldown.text = choice.cooldown + 's cooldown';
      const body = $.CreatePanel('Panel', content, 'ChoiceBody');
      const backer = $.CreatePanel('Image', body, 'CardBody', { scaling: 'stretch-to-fit' });
      backer.SetImage('s2r://panorama/images/tooltips/items/tooltip_backer_' + texture + '_psd.vtex');
      const description = $.CreatePanel('Label', body, 'ChoiceText');
      description.text = choice.description;
      const stat = $.CreatePanel('Label', body, 'ChoiceStat');
      stat.text = choice.stat;
      const footer = $.CreatePanel('Label', content, 'ChoiceSelect');
      footer.text = 'CLICK TO CHOOSE';
      button.SetPanelEvent('onactivate', () => {
        if (!special || !special.choice) command('rally_choose ' + choice.id);
      });
    });
    built = true;
  }

  function restoreTooltip() {
    description = null;
    tooltip.release();
  }
  function paintTooltip() {
    const choice = selected();
    if (stopped || !source || !source.IsValid() || !choice) return;
    let top = root;
    while (top.GetParent()) top = top.GetParent();
    top.FindChildrenWithClassTraverse('TooltipVisible').forEach(panel => {
      if (panel.paneltype !== 'CitadelTooltipAbilityDetails') return;
      const details = panel.FindChildTraverse('AbilityDetailsPanel');
      if (!details) return;
      details.FindChildrenWithClassTraverse('AbilityName').forEach(label => tooltip.relabel(label, choice.name, ['AbilityName']));
      details.FindChildrenWithClassTraverse('AbilityLevel').forEach(level => tooltip.hide(level));
      ['HeaderAttributesContainer', 'BonusContainerId', 'BrawlMsg'].forEach(id => tooltip.hide(details.FindChildTraverse(id)));
      tooltip.hide(panel.FindChildTraverse('AbilityUpgradeList'));
      const cooldown = details.FindChildTraverse('AbilityCooldown');
      if (cooldown) {
        cooldown.FindChildrenWithClassTraverse('CurrentValue').forEach(label => tooltip.relabel(label, choice.cooldown + 's', ['CurrentValue']));
        cooldown.FindChildrenWithClassTraverse('BaseValue').forEach(label => tooltip.relabel(label, choice.cooldown + 's', ['BaseValue', 'AltStateVisible']));
        tooltip.relabel(cooldown.FindChildTraverse('BaseLabel'), choice.cooldown + 's');
        tooltip.relabel(cooldown.FindChildTraverse('ModifiedLabel'), choice.cooldown + 's');
      }
      const sections = details.FindChildTraverse('SectionsContainer');
      if (!sections) return;
      for (let i = 0; i < sections.GetChildCount(); i++) {
        const child = sections.GetChild(i);
        if (child !== description) tooltip.hide(child);
      }
      if (!description || description.GetParent() !== sections) {
        description = tooltip.create('Panel', sections, 'RallySpecialDescription');
        description.AddClass('AbilityPropertiesBlock');
        description.AddClass('TopBottomFlow');
        const text = $.CreatePanel('Label', description, 'RallySpecialText');
        text.AddClass('PropertiesBlockHeaderLabel');
        text.style.whiteSpace = 'normal';
      }
      description.FindChildTraverse('RallySpecialText').text = choice.description;
    });
  }
  function showTooltip(panel) {
    if (stopped || !selected()) return;
    restoreTooltip();
    source = panel;
    const current = ++revision;
    $.DispatchEvent('CitadelShowAbilityDetailsTooltip', panel, choices.nativeAbilityId, choices.playerSlot);
    [0, 0.1].forEach(delay => $.Schedule(delay, () => { if (!stopped && revision === current) paintTooltip(); }));
  }
  function hideTooltip(panel) {
    if (source !== panel) return;
    $.DispatchEvent('CitadelHideAbilityDetailsTooltip', panel);
    source = null;
    revision++;
    restoreTooltip();
  }
  function bindAbility(panel) {
    panel.SetPanelEvent('onmouseover', () => showTooltip(panel));
    panel.SetPanelEvent('onmouseout', () => hideTooltip(panel));
    panel.SetPanelEvent('onactivate', () => { if (special && special.available) command('rally_special'); });
    for (let i = 0; i < panel.GetChildCount(); i++) bindAbility(panel.GetChild(i));
  }
  function hydrateAbility() {
    const choice = selected();
    if (!choice) return;
    const slot = ability.FindChildTraverse('slot_signature_3');
    if (!slot) return;
    const nativeImage = slot.FindChildTraverse('ability_image');
    if (!nativeImage) return;
    const ready = special.available === true;
    const container = nativeImage.GetParent();
    nativeImage.style.visibility = 'collapse';
    let image = container.FindChildTraverse('RallySpecialImage');
    if (!image) {
      // The engine owns ability_image and can replace it between our updates.
      image = $.CreatePanel('Image', container, 'RallySpecialImage', { scaling: 'stretch-to-fit-preserve-aspect' });
      image.SetImage(choice.icon);
      image.style.width = '60px';
      image.style.height = '60px';
      image.style.horizontalAlign = 'center';
      image.style.verticalAlign = 'center';
      image.style.visibility = 'visible';
    }
    image.style.opacity = ready ? '1' : '0.5';
    image.style.washColor = ready ? '#252923' : '#eeeae3';
    container.style.opacity = '1';
    container.style.washColor = 'none';
    container.style.saturation = '1';
    const mask = slot.FindChildTraverse('cooldown_mask');
    if (mask) {
      container.MoveChildBefore(image, mask);
      mask.style.opacity = ready ? '0' : '0.9';
      mask.style.visibility = 'visible';
    }
    // Native child layouts have their own CSS scope, so apply these at that boundary.
    for (let panel = slot; panel && panel !== ability; panel = panel.GetParent()) {
      panel.style.width = '100%';
      panel.style.height = '100%';
      panel.style.margin = '0px';
      panel.style.padding = '0px';
      panel.style.flowChildren = 'none';
      panel.style.horizontalAlign = 'center';
      panel.style.verticalAlign = 'center';
      panel.style.washColor = 'none';
    }
    const button = slot.FindChildTraverse('button_container');
    button.style.width = '120px';
    button.style.height = '120px';
    button.style.margin = '0px';
    button.style.horizontalAlign = 'center';
    button.style.verticalAlign = 'center';
    button.style.washColor = 'none';
    slot.FindChildrenWithClassTraverse('ability_bg').forEach(panel => {
      panel.style.opacity = ready ? '1' : '0.18';
      panel.style.washColor = '#eeeae3';
      panel.style.saturation = '1';
    });
    slot.FindChildrenWithClassTraverse('ability_key_container').forEach(panel => {
      panel.style.opacity = ready ? '1' : '0.55';
      panel.style.washColor = 'none';
    });
    ['ability_name', 'build_suggestion_container'].forEach(name => {
      slot.FindChildrenWithClassTraverse(name).forEach(panel => { panel.style.visibility = 'collapse'; });
    });
    ['AbilityLevelContainer', 'ReadOnlyPipsContainer', 'KeyboardHint', 'BonusContainer', 'ability_upgrade_binding_component'].forEach(id => {
      const panel = slot.FindChildTraverse(id);
      if (panel) panel.style.visibility = 'collapse';
    });
    bindAbility(slot);
  }

  // Native controls hydrate after layout creation and can replace their handlers.
  function refresh() {
    if (stopped) return;
    if (choices && special) {
      hydrateAbility();
      if (source) paintTooltip();
    }
    hydration = $.Schedule(0.1, refresh);
  }
  function stop() {
    stopped = true;
    if (hydration) $.CancelScheduled(hydration);
    if (source && source.IsValid()) hideTooltip(source);
  }

  function paint() {
    if (stopped || !choices || !special) return;
    root.SetHasClass('Choosing', !special.choice);
    root.SetHasClass('HasSpecial', !!special.choice);
    const choice = selected();
    label('SpecialName', choice ? choice.name : '');
    label('SpecialStatus', special.armed ? 'EMPOWERED' : '');
    hydrateAbility();
    if (source) paintTooltip();
  }

  Modlock.route('choices', value => {
    if (stopped || !value || !Array.isArray(value.choices) || value.choices.length !== 3) return;
    choices = value;
    if (!built) createCards();
    paint();
  });
  Modlock.route('special', value => {
    if (stopped || !value || typeof value !== 'object') return;
    special = value;
    paint();
  });
  Modlock.onUnload(stop);
  refresh();
})();
