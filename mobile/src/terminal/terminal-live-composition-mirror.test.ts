import { describe, expect, it } from 'vitest'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  isTerminalLiveHangulCodePoint,
  isTerminalLiveKanaCodePoint,
  type TerminalLiveMirrorStep
} from './terminal-live-composition-mirror'

type MirrorRun = {
  readonly payloads: readonly string[]
  readonly sentText: string
  readonly heldText: string
}

function runMirrorSequence(
  fieldStates: readonly string[],
  options: { readonly commitAtEnd: boolean } = { commitAtEnd: false }
): MirrorRun {
  const payloads: string[] = []
  let sentText = ''
  let heldText = ''
  for (const fieldText of fieldStates) {
    const step = computeTerminalLiveMirrorStep(sentText, fieldText, { commitHeld: false })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  if (options.commitAtEnd) {
    const lastField = sentText + heldText
    const step = computeTerminalLiveMirrorStep(sentText, lastField, { commitHeld: true })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  return { payloads, sentText, heldText }
}

describe('terminal live hangul mirror', () => {
  it('Given single-syllable composition When steps run Then leaks no jamo and commits only the final syllable', () => {
    // Given / When
    const run = runMirrorSequence(['ㅎ', '하', '한'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['한'])
    expect(run.sentText).toBe('한')
    expect(run.heldText).toBe('')
  })

  it('Given multi-syllable composition When a new syllable starts Then streams the stable prefix without erases', () => {
    // Given / When
    const run = runMirrorSequence(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['한', '글'])
    expect(run.sentText).toBe('한글')
  })

  it('Given dubeolsik resplit 간→가나 When steps run Then never sends the intermediate syllable', () => {
    // Given / When
    const run = runMirrorSequence(['ㄱ', '가', '간', '가나'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['가', '나'])
    expect(run.sentText).toBe('가나')
  })

  it('Given a timer-committed syllable When composition continues Then erases and recommits via DEL correction', () => {
    // Given: '하' was committed by the settle timer
    const commit = computeTerminalLiveMirrorStep('', '하', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(commit)).toBe('하')
    expect(commit.nextSentText).toBe('하')

    // When: user keeps composing '하' → '한'
    const correction = computeTerminalLiveMirrorStep(commit.nextSentText, '한', {
      commitHeld: false
    })

    // Then: one DEL erases the stale syllable; the new one is held again
    expect(buildTerminalLiveMirrorPayload(correction)).toBe('\x7f')
    expect(correction.nextSentText).toBe('')
    expect(correction.heldText).toBe('한')

    const recommit = computeTerminalLiveMirrorStep('', '한', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(recommit)).toBe('한')
  })

  it('Given pure ASCII typing When steps run Then mirrors immediately with no held text', () => {
    // Given / When
    const run = runMirrorSequence(['a', 'ab', 'abc'])

    // Then
    expect(run.payloads).toEqual(['a', 'b', 'c'])
    expect(run.heldText).toBe('')
  })

  it('Given a trailing space after Hangul When the step runs Then the space commits the held syllable', () => {
    // Given: '한글' typed, '한' streamed, '글' held
    const beforeSpace = runMirrorSequence(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'])
    expect(beforeSpace.sentText).toBe('한')
    expect(beforeSpace.heldText).toBe('글')

    // When
    const step = computeTerminalLiveMirrorStep(beforeSpace.sentText, '한글 ', {
      commitHeld: false
    })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('글 ')
    expect(step.heldText).toBe('')
    expect(step.nextSentText).toBe('한글 ')
  })

  it('Given a trailing ASCII letter after Hangul When the step runs Then Hangul is committed with the letter', () => {
    // Given
    const held = computeTerminalLiveMirrorStep('', '한', { commitHeld: false })
    expect(held.heldText).toBe('한')

    // When
    const step = computeTerminalLiveMirrorStep(held.nextSentText, '한a', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('한a')
    expect(step.heldText).toBe('')
  })

  it('Given sent text When the user deletes everything Then erases with one DEL per code point', () => {
    // Given / When
    const step = computeTerminalLiveMirrorStep('한글a', '', { commitHeld: false })

    // Then
    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 3,
      appendText: '',
      nextSentText: '',
      heldText: '',
      heldCommitPolicy: 'none'
    })
    expect(buildTerminalLiveMirrorPayload(step)).toBe('\x7f\x7f\x7f')
  })

  it('Given empty field and empty sent text When committing Then produces a zero step', () => {
    // Given / When
    const step = computeTerminalLiveMirrorStep('', '', { commitHeld: true })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('')
    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 0,
      appendText: '',
      nextSentText: '',
      heldText: '',
      heldCommitPolicy: 'none'
    })
  })

  it('Given non-Hangul IME text When the step runs Then it mirrors immediately without holding', () => {
    // Given / When
    const chinese = computeTerminalLiveMirrorStep('', '你好', { commitHeld: false })
    const vietnamese = computeTerminalLiveMirrorStep('', 'tiếng', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(chinese)).toBe('你好')
    expect(chinese.heldText).toBe('')
    expect(buildTerminalLiveMirrorPayload(vietnamese)).toBe('tiếng')
    expect(vietnamese.heldText).toBe('')
  })

  it('Given Hangul code point ranges When checked Then jamo and syllables match and ASCII does not', () => {
    expect(isTerminalLiveHangulCodePoint('ㅎ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveHangulCodePoint('한'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveHangulCodePoint('a'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveHangulCodePoint('あ'.codePointAt(0) ?? 0)).toBe(false)
  })
})

describe('terminal live kana composition mirror', () => {
  // Issue #7427: a Japanese flick keyboard replaces the kana already on screen,
  // so forwarding the base kana lands a character the user never committed.
  it.each([
    ['small kana', 'つ', 'っ'],
    ['dakuten', 'か', 'が'],
    ['handakuten', 'は', 'ぱ']
  ])(
    'Given %s composition When the modifier replaces the base kana Then only the result is sent',
    (_label, baseKana, modifiedKana) => {
      // Given / When
      const run = runMirrorSequence([baseKana, modifiedKana], { commitAtEnd: true })

      // Then: the provisional base kana never reached the PTY, so no DEL repair
      expect(run.payloads).toEqual([modifiedKana])
      expect(run.sentText).toBe(modifiedKana)
    }
  )

  it('Given flick kana composition When syllables accumulate Then streams the stable prefix and holds the trailing kana', () => {
    // Given / When
    const run = runMirrorSequence(['こ', 'こん', 'こんに', 'こんにち', 'こんにちは'])

    // Then
    expect(run.payloads).toEqual(['こ', 'ん', 'に', 'ち'])
    expect(run.heldText).toBe('は')
  })

  it('Given a held kana When the field commits Then the mirror emits the full text once', () => {
    // Given / When
    const run = runMirrorSequence(['こ', 'こん', 'こんに', 'こんにち', 'こんにちは'], {
      commitAtEnd: true
    })

    // Then
    expect(run.payloads.join('')).toBe('こんにちは')
    expect(run.heldText).toBe('')
  })

  it('Given kana and Hangul holds When policies are read Then only Hangul may commit on the settle timer', () => {
    // Given / When
    const kana = computeTerminalLiveMirrorStep('', 'つ', { commitHeld: false })
    const hangul = computeTerminalLiveMirrorStep('', '한', { commitHeld: false })
    const ascii = computeTerminalLiveMirrorStep('', 'a', { commitHeld: false })

    // Then
    expect(kana.heldCommitPolicy).toBe('boundary')
    expect(hangul.heldCommitPolicy).toBe('timer')
    expect(ascii.heldCommitPolicy).toBe('none')
  })

  it('Given romaji conversion output When the step runs Then kanji commits immediately instead of being held', () => {
    // Given: 'にほんご' was mirrored, then the IME converted it
    const step = computeTerminalLiveMirrorStep('にほんご', '日本語', { commitHeld: false })

    // Then: conversion output is final, so nothing is held back
    expect(buildTerminalLiveMirrorPayload(step)).toBe('\x7f\x7f\x7f\x7f日本語')
    expect(step.heldText).toBe('')
    expect(step.heldCommitPolicy).toBe('none')
  })

  it('Given kana code point ranges When checked Then hiragana, katakana and halfwidth katakana match', () => {
    expect(isTerminalLiveKanaCodePoint('あ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveKanaCodePoint('ッ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveKanaCodePoint('ー'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveKanaCodePoint('ｶ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveKanaCodePoint('語'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveKanaCodePoint('a'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveKanaCodePoint('한'.codePointAt(0) ?? 0)).toBe(false)
  })
})
