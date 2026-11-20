let audioContext: AudioContext | null = null

/**
 * Короткий двухтональный сигнал о новом критическом инциденте.
 * WebAudio требует жеста пользователя: если контекст заблокирован,
 * пробуем resume, при неудаче ошибка уходит в консоль.
 */
export function beepCritical(): void {
  try {
    const Ctor = window.AudioContext
    if (typeof Ctor !== 'function') return
    audioContext ??= new Ctor()
    const ctx = audioContext
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(err => console.error('Не удалось возобновить аудиоконтекст', err))
    }
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)
    osc.frequency.setValueAtTime(660, t + 0.15)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.32)
  } catch (err) {
    console.error('Не удалось воспроизвести звуковой сигнал', err)
  }
}
