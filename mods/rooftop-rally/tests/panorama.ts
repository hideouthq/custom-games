export class Panel {
  children: Panel[] = []
  classes = new Set<string>()
  events = new Map<string, () => void>()
  attributes = new Map<string, string>()
  private shown = true
  // As Panorama does: an inline visibility sets visible, setting visible
  // writes the inline visibility, and clearing it leaves visible as it was,
  // since these panels have no CSS of their own.
  readonly style = new Proxy<Record<string, string | null>>(
    {},
    {
      set: (style, name: string, value: string | null) => {
        if (name === 'visibility' && value !== null)
          this.shown = value !== 'collapse'
        style[name] = value
        return true
      },
    },
  )
  get visible(): boolean {
    return this.shown
  }
  set visible(value: boolean) {
    this.style.visibility = value ? 'visible' : 'collapse'
  }
  text = ''
  image = ''
  valid = true
  made = false
  hittest = true
  hittestchildren = true
  constructor(
    public id: string,
    private parent: Panel | null = null,
    public paneltype = 'Panel',
  ) {
    parent?.children.push(this)
  }
  GetParent(): Panel | null {
    return this.parent
  }
  IsValid(): boolean {
    return this.valid
  }
  DeleteAsync(): void {
    this.valid = false
  }
  GetChildCount(): number {
    return this.children.length
  }
  GetChild(i: number): Panel | undefined {
    return this.children[i]
  }
  AddClass(name: string): void {
    this.classes.add(name)
  }
  SetHasClass(name: string, value: boolean): void {
    value ? this.classes.add(name) : this.classes.delete(name)
  }
  SetImage(value: string): void {
    this.image = value
  }
  SetPanelEvent(name: string, action: () => void): void {
    this.events.set(name, action)
  }
  GetAttributeString(name: string, fallback: string): string {
    return this.attributes.get(name) ?? fallback
  }
  SetAttributeString(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  MoveChildBefore(child: Panel, before: Panel): void {
    this.children.splice(this.children.indexOf(child), 1)
    this.children.splice(this.children.indexOf(before), 0, child)
  }
  MoveChildAfter(child: Panel, after: Panel): void {
    this.children.splice(this.children.indexOf(child), 1)
    this.children.splice(this.children.indexOf(after) + 1, 0, child)
  }
  FindChildTraverse(id: string): Panel | undefined {
    for (const child of this.children) {
      if (!child.valid) continue
      if (child.id === id) return child
      const nested = child.FindChildTraverse(id)
      if (nested) return nested
    }
    return undefined
  }
  FindChildrenWithClassTraverse(name: string): Panel[] {
    return this.children.flatMap((child) => [
      ...(child.classes.has(name) ? [child] : []),
      ...child.FindChildrenWithClassTraverse(name),
    ])
  }
}
