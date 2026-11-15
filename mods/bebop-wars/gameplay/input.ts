export interface InputGate { readonly context: string; readonly armed: boolean }
export function inputGate(previous: InputGate | undefined, context: string, held: bigint, actionMask: bigint): InputGate {
  if (!previous || previous.context !== context) return { context, armed: false }
  return { context, armed: previous.armed || (held & actionMask) === 0n }
}
