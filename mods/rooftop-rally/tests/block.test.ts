import { expect, test } from 'bun:test'
import { Block } from '../gameplay/block'

test('a press protects for 0.4 seconds and becomes available 0.8 seconds after activation', () => {
  const block = new Block()
  expect(block.window).toBeUndefined()
  expect(block.press(10)).toBe(true)
  expect(block.window).toEqual({ started: 10, ends: 10.4 })
  expect(block.press(10.2)).toBe(false)
  expect(block.window?.ends).toBe(10.4)
  expect(block.press(10.79)).toBe(false)
  expect(block.press(10.8)).toBe(true)
})

test('a successful return refresh allows a new window without reusing the old one', () => {
  const block = new Block()
  block.press(10)
  block.refresh(10.3)
  expect(block.window).toEqual({ started: 10, ends: 10.4 })
  expect(block.press(10.3)).toBe(true)
  expect(block.window?.started).toBe(10.3)
  expect(block.window?.ends).toBeCloseTo(10.7)
  expect(block.cooldown(10.3)).toBeCloseTo(0.8)
})

test('holding repeats at readiness without extending the current window', () => {
  const block = new Block(),
    activations: number[] = []
  block.input(1n, 0n)
  for (let frame = 0; frame <= 20; frame++) {
    const now = frame / 10
    if (block.takeRequest() && block.press(now)) activations.push(now)
    if (frame === 4) expect(block.window?.ends).toBe(now)
  }
  expect(activations).toEqual([0, 0.8, 1.6])
  block.input(0n, 1n)
  expect(block.takeRequest()).toBe(false)
})

test('either held binding sustains the request and releasing both cancels it', () => {
  const block = new Block()
  block.input(1n, 0n)
  block.takeRequest()
  block.press(0)
  block.input(2n, 0n)
  expect(block.press(0.2)).toBe(false)
  block.input(0n, 1n)
  expect(block.takeRequest()).toBe(true)
  expect(block.press(0.8)).toBe(true)
  block.input(0n, 2n)
  expect(block.takeRequest()).toBe(false)
})

test('releasing during cooldown cancels the repeat while a fresh spawn clears timing only', () => {
  const block = new Block()
  block.input(1n, 0n)
  block.takeRequest()
  block.press(0)
  block.input(0n, 1n)
  expect(block.takeRequest()).toBe(false)
  block.input(2n, 0n)
  block.reset()
  expect(block.window).toBeUndefined()
  expect(block.takeRequest()).toBe(true)
  expect(block.press(0.1)).toBe(true)
})

test('a quick tap survives release until the next frame but does not queue beyond it', () => {
  const block = new Block()
  block.press(10)
  block.input(1n, 0n)
  block.input(0n, 1n)
  expect(block.takeRequest()).toBe(true)
  expect(block.press(10.8125)).toBe(true)
  expect(block.takeRequest()).toBe(false)
  block.input(1n, 1n)
  expect(block.takeRequest()).toBe(true)
  expect(block.press(10.9)).toBe(false)
  expect(block.takeRequest()).toBe(false)
})
