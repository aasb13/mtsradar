import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { relativeTime } from '../format'
import { navigate, routeQuery } from '../router'
import { useApp } from '../store'
import type { ChatActionTrace, ChatAttachment, ChatMessage, ChatSession } from '../types'
import {
  AlertIcon,
  Avatar,
  Button,
  CheckCircleIcon,
  CloseIcon,
  DownloadIcon,
  EmptyState,
  FileIcon,
  Markdown,
  Modal,
  PlusIcon,
  SendIcon,
  Spinner,
  SparkIcon,
  Textarea,
  TrashIcon,
  UndoIcon,
} from '../ui'

/** Ответ BigDad, который печатается прямо сейчас (стрим). */
interface LiveReply {
  id: string
  text: string
  actions: ChatActionTrace[]
}

/** Чат с ИИ-агентом BigDad: сессии, история, сообщения, вложения, ответ на предложение. */
export function ChatPage() {
  const { state, showToast } = useApp()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [waiting, setWaiting] = useState(false)
  const [stream, setStream] = useState<LiveReply | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<ChatAttachment[]>([])
  const [replyTo, setReplyTo] = useState<ChatReply | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<ChatSession | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  // лента не дёргается, пока пользователь читает историю: автопрокрутка только у нижнего края
  const pinnedToBottom = useRef(true)
  // SSE приходит по токенам: копим текст в ref и обновляем экран один раз за кадр
  const liveRef = useRef<LiveReply | null>(null)
  const liveFrame = useRef<number | null>(null)
  // отложенный вопрос из панели инцидента («Обсудить в чате»); state, а не ref:
  // ставится из обработчика popstate, и эффект отправки должен на это отреагировать
  const [queuedDraft, setQueuedDraft] = useState<{ incidentId: string; text: string } | null>(null)
  // зеркало activeId: navigate dispatch'ит popstate до re-render, state туда опаздывает
  const activeIdRef = useRef<string | null>(null)
  const activate = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
  }, [])
  const aiEnabled = state.dictionaries?.aiEnabled !== false

  const flushLive = useCallback(() => {
    liveFrame.current = null
    setStream(liveRef.current === null ? null : { ...liveRef.current })
  }, [])

  const scheduleLive = useCallback(() => {
    if (liveFrame.current === null) liveFrame.current = requestAnimationFrame(flushLive)
  }, [flushLive])

  useEffect(
    () => () => {
      if (liveFrame.current !== null) cancelAnimationFrame(liveFrame.current)
    },
    [],
  )

  const activeSession = useMemo(
    () => sessions.find(s => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  const refreshSessions = useCallback(async () => {
    try {
      const res = await api.fetchChatSessions()
      setSessions(res.items)
      return res.items
    } catch (err) {
      console.error('Не удалось загрузить сессии чата', err)
      return []
    }
  }, [])

  const openSession = useCallback(
    async (id: string, replaceUrl: boolean) => {
      activate(id)
      pinnedToBottom.current = true
      setReplyTo(null)
      try {
        const res = await api.fetchChatSession(id)
        setMessages(res.messages)
        setSessions(prev => prev.map(s => (s.id === id ? res.session : s)))
        if (replaceUrl) navigate(`/chat?s=${id}`, true)
        return res
      } catch (err) {
        console.error('Не удалось открыть сессию чата', err)
        showToast('Не удалось открыть сессию чата', 'warning')
        activate(null)
        setMessages([])
        return null
      }
    },
    [activate, showToast],
  )

  /** Откат сессии, созданной для сообщения, которое не дошло до сервера. */
  const discardSession = useCallback(
    (sid: string) => {
      setSessions(prev => prev.filter(s => s.id !== sid))
      if (activeIdRef.current === sid) {
        activate(null)
        setMessages([])
        navigate('/chat', true)
      }
    },
    [activate],
  )

  /** Сообщение в сессию со стримом ответа BigDad. onUndelivered — если сервер не принял
   * сообщение (ни одного события стрима не пришло): отправитель возвращает введённый текст
   * и убирает только что созданную пустую беседу. */
  const runExchange = useCallback(
    async (
      sid: string,
      value: string,
      attachmentIds: string[],
      replyToMessageId: string | null,
      onUndelivered?: () => void,
    ) => {
      setWaiting(true)
      let delivered = false // событие user всегда первое в стриме — значит, сообщение принято
      let undone = false
      const giveUp = () => {
        if (undone) return
        undone = true
        onUndelivered?.()
      }
      try {
        await api.streamChatMessage(sid, { text: value, attachmentIds, replyToMessageId: replyToMessageId ?? undefined }, {
          user: m => {
            delivered = true
            setMessages(prev => [...prev, m])
          },
          start: id => {
            liveRef.current = { id, text: '', actions: [] }
            scheduleLive()
          },
          text: chunk => {
            if (liveRef.current === null) return
            liveRef.current.text += chunk
            scheduleLive()
          },
          tool: t => {
            if (liveRef.current === null) return
            liveRef.current.actions.push(t)
            scheduleLive()
          },
          done: (m, session) => {
            // финальное сообщение приходит вместе со стримом — убираем черновик в тот же кадр,
            // иначе на миг отрисуется дубль текста и лента дёрнется
            if (liveFrame.current !== null) {
              cancelAnimationFrame(liveFrame.current)
              liveFrame.current = null
            }
            liveRef.current = null
            setStream(null)
            // итог может прийти и по WebSocket раньше стрима — не дублируем
            setMessages(prev => (prev.some(x => x.id === m.id) ? prev : [...prev, m]))
            setSessions(prev => prev.map(x => (x.id === session.id ? session : x)))
          },
          error: message => showToast(message, 'warning'),
        })
        // сервер может отдать error внутри стрима, не прерывая запрос — пустая беседа не нужна
        if (!delivered) giveUp()
      } catch (err) {
        console.error('Не удалось отправить сообщение', err)
        showToast(
          err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не отвечает',
          'warning',
        )
        if (!delivered) giveUp()
      } finally {
        if (liveFrame.current !== null) {
          cancelAnimationFrame(liveFrame.current)
          liveFrame.current = null
        }
        liveRef.current = null
        setStream(null)
        setWaiting(false)
      }
    },
    [scheduleLive, showToast],
  )

  // начальная загрузка + открытие сессии из ссылки и «Обсудить в чате» (?s=… / ?draft=…)
  useEffect(() => {
    const applyQuery = (replaceUrl: boolean) => {
      const q = routeQuery()
      const sid = q.get('s')
      if (sid !== null) {
        // navigate сам dispatch'ит popstate; перезагрузка открытой сессии стёрла бы стрим
        if (sid !== activeIdRef.current) void openSession(sid, replaceUrl)
        return
      }
      const incidentId = q.get('incident')
      const draft = q.get('draft')
      if (incidentId !== null && draft !== null && draft !== '') {
        setQueuedDraft({ incidentId, text: draft })
        navigate('/chat', true)
      }
    }
    void (async () => {
      const items = await refreshSessions()
      const sid = routeQuery().get('s')
      if (sid !== null && items.some(s => s.id === sid)) {
        void openSession(sid, true)
      } else {
        applyQuery(true)
      }
    })()
    const onRoute = () => applyQuery(false)
    window.addEventListener('popstate', onRoute)
    return () => window.removeEventListener('popstate', onRoute)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // отправка отложенного вопроса из панели инцидента («Обсудить в чате»); ждём,
  // пока не завершится текущий стрим — вторую сессию параллельно не начинаем
  useEffect(() => {
    if (queuedDraft === null || waiting) return
    const { incidentId, text: question } = queuedDraft
    setQueuedDraft(null)
    void (async () => {
      try {
        const res = await api.createChatSession({ incidentId })
        setSessions(prev => [res.session, ...prev.filter(s => s.id !== res.session.id)])
        activate(res.session.id)
        setMessages([])
        navigate(`/chat?s=${res.session.id}`, true)
        pinnedToBottom.current = true
        await runExchange(res.session.id, question, [], null, () => {
          setText(question) // вопрос не пропал — его можно отправить вручную
          discardSession(res.session.id)
        })
      } catch (err) {
        console.error('Не удалось начать чат с BigDad', err)
        showToast(
          err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не отвечает',
          'warning',
        )
        setText(question) // вопрос не пропал — его можно отправить вручную
      }
    })()
  }, [activate, discardSession, queuedDraft, runExchange, waiting, showToast])

  // живое обновление по WebSocket (ответ агента в другой вкладке)
  useEffect(() => {
    const onChat = (e: Event) => {
      const payload = (e as CustomEvent<Record<string, unknown>>).detail
      const incoming = Array.isArray(payload.messages) ? (payload.messages as ChatMessage[]) : []
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
      if (sessionId !== null) {
        const incomingSession =
          typeof payload.session === 'object' && payload.session !== null
            ? (payload.session as Partial<ChatSession> & { id: string })
            : null
        setSessions(prev => {
          const next =
            incomingSession === null
              ? prev
              : prev.some(s => s.id === sessionId)
                ? prev.map(s => (s.id === sessionId ? { ...s, ...incomingSession } : s))
                : ([{ ...incomingSession, id: sessionId } as ChatSession, ...prev])
          return [...next].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        })
      }
      if (sessionId !== null && sessionId === activeId && incoming.length > 0) {
        setMessages(prev => {
          const known = new Set(prev.map(m => m.id))
          return [...prev, ...incoming.filter(m => !known.has(m.id))]
        })
      }
    }
    window.addEventListener('radar:chat', onChat)
    return () => window.removeEventListener('radar:chat', onChat)
  }, [activeId])

  useLayoutEffect(() => {
    const feed = feedRef.current
    if (feed !== null && pinnedToBottom.current) feed.scrollTop = feed.scrollHeight
  }, [messages, stream, waiting])

  const onFeedScroll = () => {
    const feed = feedRef.current
    if (feed === null) return
    pinnedToBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
  }

  const newSession = () => {
    activate(null)
    pinnedToBottom.current = true
    setMessages([])
    setReplyTo(null)
    setText('')
    setPending([])
    setStream(null)
    navigate('/chat', true)
  }

  const removeSession = async () => {
    if (deleting === null || deletingBusy) return
    const id = deleting.id
    setDeletingBusy(true)
    try {
      await api.deleteChatSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeId === id) newSession()
      setDeleting(null)
    } catch (err) {
      console.error('Не удалось удалить сессию', err)
      showToast('Не удалось удалить сессию', 'warning')
    } finally {
      setDeletingBusy(false)
    }
  }

  const attachFiles = async (files: FileList) => {
    const room = MAX_ATTACHMENTS - pending.length
    if (room <= 0) {
      showToast('Не больше 5 файлов на сообщение', 'warning')
      return
    }
    setUploading(true)
    try {
      const uploaded: ChatAttachment[] = []
      for (const file of Array.from(files).slice(0, room)) {
        const res = await api.uploadChatFile(file)
        uploaded.push(res)
      }
      setPending(prev => [...prev, ...uploaded])
    } catch (err) {
      console.error('Не удалось загрузить файл', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось загрузить файл', 'warning')
    } finally {
      setUploading(false)
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }

  const send = async () => {
    const value = text.trim()
    if (value === '' || waiting || !aiEnabled) return
    const attachmentIds = pending.map(a => a.id)
    const replyToMessageId = replyTo?.messageId ?? null
    const prevPending = pending
    const prevReply = replyTo
    const restore = () => {
      // возвращаем то, что пользователь ввёл: сообщение не должно пропасть из-за сбоя
      setText(value)
      setPending(prevPending)
      setReplyTo(prevReply)
    }
    setText('')
    setPending([])
    setReplyTo(null)
    pinnedToBottom.current = true
    setWaiting(true)
    try {
      let sid = activeId
      let createdSid: string | null = null
      if (sid === null) {
        const res = await api.createChatSession({})
        sid = res.session.id
        createdSid = sid
        setSessions(prev => [res.session, ...prev.filter(s => s.id !== sid)])
        activate(sid)
        setMessages([])
        navigate(`/chat?s=${sid}`, true)
      }
      await runExchange(sid, value, attachmentIds, replyToMessageId, () => {
        restore()
        if (createdSid !== null) discardSession(createdSid)
      })
    } catch (err) {
      // не удалось даже создать сессию — сообщение не ушло
      console.error('Не удалось отправить сообщение', err)
      showToast(
        err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не отвечает',
        'warning',
      )
      restore()
      setWaiting(false)
    }
  }

  return (
    <div className="chat">
      <aside className="chat__side">
        <div className="chat__sidehead">
          <div className="chat__sidetitle">
            <span>Беседы</span>
            <span className="chat__sidecount">{sessions.length}</span>
          </div>
          <Button variant="primary" className="btn--sm chat__new" onClick={newSession}>
            <PlusIcon size={14} />
            Новый чат
          </Button>
        </div>
        <div className="chat__sessions">
          {sessions.length === 0 && <p className="chat__nosessions">Пока нет бесед с BigDad</p>}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`chat__session ${s.id === activeId ? 'chat__session--active' : ''}`}
              onClick={() => void openSession(s.id, false)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="chat__sessiontitle">{s.title}</p>
                <p className="chat__sessiontime">{relativeTime(s.updatedAt, state.now)}</p>
              </div>
              <button
                type="button"
                className="chat__sessiondel"
                aria-label="Удалить сессию"
                title="Удалить сессию"
                onClick={e => {
                  e.stopPropagation()
                  setDeleting(s)
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat__main">
        <header className="chat__header">
          <span className="chat__header-icon">
            <SparkIcon size={18} />
          </span>
          <div className="chat__header-text">
            <h2>BigDad</h2>
            <p>ИИ-координатор: разбирает инциденты и подсказывает действия</p>
          </div>
          <span className={`chat__status ${aiEnabled ? '' : 'chat__status--off'}`}>
            <i />
            {aiEnabled ? 'на связи' : 'не подключён'}
          </span>
        </header>
        <div className="chat__feed" ref={feedRef} onScroll={onFeedScroll}>
          {messages.length === 0 && !waiting && (
            <div className="chat__placeholder">
              <EmptyState
                title="Чат с BigDad"
                note="Спросите про инциденты и команды, попросите назначить команду, изменить приоритет или срок — BigDad работает с вашими правами и делает сам."
              />
            </div>
          )}
          {activeSession !== null && activeSession.incidentId !== null && (
            <div className="chat__ctx">
              <SparkIcon size={13} />
              Чат об инциденте {activeSession.incidentId}
            </div>
          )}
          {messages.length > 0 && <div className="chat__day"><span>Сегодня</span></div>}
          {messages.map(m => (
            <MessageRow key={m.id} message={m} now={state.now} onReply={setReplyTo} />
          ))}
          {stream !== null && (
            <div className="chat__row chat__row--live">
              <span className="chat__ava">
                <SparkIcon size={16} />
              </span>
              <div className="bubble bubble--assistant bubble--live">
                {stream.actions.length > 0 && (
                  <div className="bubble__actions">
                    {stream.actions.map((a, i) => (
                      <span key={i} className={`trace ${a.ok ? '' : 'trace--fail'}`}>
                        {a.ok ? <CheckCircleIcon size={13} /> : <AlertIcon size={13} />}
                        {a.summary}
                      </span>
                    ))}
                  </div>
                )}
                {stream.text !== '' ? (
                  <Markdown text={stream.text} />
                ) : (
                  <p className="chat__thinking">
                    BigDad думает<span className="chat__dots"><i /><i /><i /></span>
                  </p>
                )}
              </div>
            </div>
          )}
          {waiting && stream === null && (
            <div className="chat__row chat__row--thinking">
              <span className="chat__ava">
                <SparkIcon size={16} />
              </span>
              <div className="bubble bubble--assistant bubble--thinking">
                <p className="chat__thinking">
                  BigDad думает<span className="chat__dots"><i /><i /><i /></span>
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="chat__composer">
          {!aiEnabled && (
            <p className="chat__offnote">BigDad не подключён — задайте LLM_API_BASE и LLM_MODEL и перезайдите</p>
          )}
          {replyTo !== null && (
            <div className="chat__quote">
              <UndoIcon size={13} />
              <span>Ответ на: «{replyTo.snippet}»</span>
              <button type="button" aria-label="Убрать ответ" onClick={() => setReplyTo(null)}>
                <CloseIcon size={12} />
              </button>
            </div>
          )}
          {pending.length > 0 && (
            <div className="chat__files">
              {pending.map(a => (
                <span key={a.id} className="chat__file">
                  <FileIcon size={13} />
                  {a.name}
                  <button
                    type="button"
                    aria-label="Убрать файл"
                    onClick={() => setPending(prev => prev.filter(x => x.id !== a.id))}
                  >
                    <CloseIcon size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="chat__inputrow">
            <button
              type="button"
              className="iconbtn"
              aria-label="Прикрепить файл"
              title="Прикрепить файл"
              disabled={uploading || !aiEnabled}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Spinner size={16} /> : <FileIcon size={16} />}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => e.target.files !== null && void attachFiles(e.target.files)}
            />
            <Textarea
              className="chat__input"
              value={text}
              placeholder="Спросите BigDad или попросите что-то сделать…"
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <Button
              variant="primary"
              className="btn--sm"
              disabled={waiting || text.trim() === '' || !aiEnabled}
              onClick={() => void send()}
            >
              <SendIcon size={15} />
              Отправить
            </Button>
          </div>
          <p className="chat__hint">Enter — отправить · Shift + Enter — новая строка · до 5 файлов</p>
        </div>
      </section>
      {deleting !== null && (
        <Modal
          title="Удалить чат?"
          onClose={() => setDeleting(null)}
          width={440}
          footer={
            <>
              <span className="spacer" />
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Отмена
              </Button>
              <Button variant="danger" disabled={deletingBusy} onClick={() => void removeSession()}>
                Удалить
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-2)' }}>
            Беседа «{deleting.title}» и все её сообщения будут удалены безвозвратно.
          </p>
        </Modal>
      )}
    </div>
  )
}

interface ChatReply {
  messageId: string
  snippet: string
}

const MAX_ATTACHMENTS = 5

const MessageRow = memo(function MessageRow({
  message,
  now,
  onReply,
}: {
  message: ChatMessage
  now: number
  onReply: (reply: ChatReply) => void
}) {
  const mine = message.role === 'user'
  return (
    <div className={`chat__row ${mine ? 'chat__row--mine' : ''}`}>
      {!mine && (
        <span className="chat__ava">
          <SparkIcon size={16} />
        </span>
      )}
      <div className={`bubble ${mine ? 'bubble--user' : 'bubble--assistant'}`}>
        {message.replyTo !== null && <p className="bubble__quote">↩ {message.replyTo.snippet}</p>}
        {mine ? <p className="bubble__text">{message.text}</p> : <Markdown text={message.text} />}
        {message.actions.length > 0 && (
          <div className="bubble__actions">
            {message.actions.map((a, i) => (
              <span key={i} className={`trace ${a.ok ? '' : 'trace--fail'}`}>
                {a.ok ? <CheckCircleIcon size={13} /> : <AlertIcon size={13} />}
                {a.summary}
              </span>
            ))}
          </div>
        )}
        {message.attachments.length > 0 && (
          <div className="bubble__files">
            {message.attachments.map(a => (
              <button
                key={a.id}
                type="button"
                className="chat__file chat__file--link"
                title={`Скачать ${a.name}`}
                onClick={() => void api.downloadChatFile(a.id, a.name)}
              >
                <FileIcon size={13} />
                {a.name}
                <DownloadIcon size={13} />
              </button>
            ))}
          </div>
        )}
        <div className="bubble__meta">
          <span>{relativeTime(message.createdAt, now)}</span>
          {!mine && (
            <button
              type="button"
              className="bubble__reply"
              onClick={() =>
                onReply({ messageId: message.id, snippet: message.text.slice(0, 80) })
              }
            >
              <UndoIcon size={12} />
              Ответить
            </button>
          )}
        </div>
      </div>
      {mine && (
        <span className="chat__ava chat__ava--user">
          <Avatar size="sm" tone="violet" />
        </span>
      )}
    </div>
  )
})
