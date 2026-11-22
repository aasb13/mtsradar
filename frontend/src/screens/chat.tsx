import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  PlusIcon,
  SendIcon,
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
  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<{ incidentId: string; text: string } | null>(null)
  // зеркало activeId: navigate dispatch'ит popstate до re-render, state туда опаздывает
  const activeIdRef = useRef<string | null>(null)
  const activate = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
  }, [])
  const aiEnabled = state.dictionaries?.aiEnabled !== false

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
      setReplyTo(null)
      try {
        const res = await api.fetchChatSession(id)
        setMessages(res.messages)
        setSessions(prev => {
          const rest = prev.filter(s => s.id !== id)
          return [res.session, ...rest]
        })
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

  /** Сообщение в сессию со стримом ответа BigDad. onUndelivered — если сервер не принял
   * сообщение (ни одного события стрима не пришло): отправитель возвращает введённый текст. */
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
      try {
        await api.streamChatMessage(sid, { text: value, attachmentIds, replyToMessageId: replyToMessageId ?? undefined }, {
          user: m => {
            delivered = true
            setMessages(prev => [...prev, m])
          },
          start: id => setStream({ id, text: '', actions: [] }),
          text: chunk => setStream(s => (s === null ? s : { ...s, text: s.text + chunk })),
          tool: t => setStream(s => (s === null ? s : { ...s, actions: [...s.actions, t] })),
          done: (m, session) => {
            // итог может прийти и по WebSocket раньше стрима — не дублируем
            setMessages(prev => (prev.some(x => x.id === m.id) ? prev : [...prev, m]))
            setSessions(prev => prev.map(x => (x.id === session.id ? session : x)))
          },
          error: message => showToast(message, 'warning'),
        })
      } catch (err) {
        console.error('Не удалось отправить сообщение', err)
        showToast(
          err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не отвечает',
          'warning',
        )
        if (!delivered) onUndelivered?.()
      } finally {
        setStream(null)
        setWaiting(false)
      }
    },
    [showToast],
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
      if (incidentId !== null && draft !== null && draft !== '' && !waiting) {
        draftRef.current = { incidentId, text: draft }
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

  // запуск отложенного вопроса из панели инцидента («Обсудить в чате»)
  useEffect(() => {
    if (draftRef.current === null || waiting) return
    const { incidentId, text: draft } = draftRef.current
    draftRef.current = null
    void (async () => {
      try {
        const res = await api.createChatSession({ incidentId })
        setSessions(prev => [res.session, ...prev.filter(s => s.id !== res.session.id)])
        activate(res.session.id)
        setMessages([])
        navigate(`/chat?s=${res.session.id}`, true)
        await runExchange(res.session.id, draft, [], null)
      } catch (err) {
        console.error('Не удалось начать чат с BigDad', err)
        showToast(
          err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не отвечает',
          'warning',
        )
      }
    })()
  }, [activate, runExchange, waiting, showToast])

  // живое обновление по WebSocket (ответ агента в другой вкладке)
  useEffect(() => {
    const onChat = (e: Event) => {
      const payload = (e as CustomEvent<Record<string, unknown>>).detail
      const incoming = Array.isArray(payload.messages) ? (payload.messages as ChatMessage[]) : []
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
      if (sessionId !== null) {
        setSessions(prev => {
          const known = prev.some(s => s.id === sessionId)
          if (known || typeof payload.session !== 'object' || payload.session === null) return prev
          return [payload.session as ChatSession, ...prev]
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, waiting, stream])

  const newSession = () => {
    activate(null)
    setMessages([])
    setReplyTo(null)
    setText('')
    setPending([])
    setStream(null)
    navigate('/chat', true)
  }

  const removeSession = async (id: string) => {
    try {
      await api.deleteChatSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeId === id) newSession()
    } catch (err) {
      console.error('Не удалось удалить сессию', err)
      showToast('Не удалось удалить сессию', 'warning')
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
    setWaiting(true)
    try {
      let sid = activeId
      if (sid === null) {
        const res = await api.createChatSession({})
        sid = res.session.id
        setSessions(prev => [res.session, ...prev.filter(s => s.id !== sid)])
        activate(sid)
        setMessages([])
        navigate(`/chat?s=${sid}`, true)
      }
      await runExchange(sid, value, attachmentIds, replyToMessageId, restore)
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
          <Button variant="primary" className="btn--sm" onClick={newSession}>
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
                  void removeSession(s.id)
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat__main">
        <div className="chat__feed">
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
          {messages.map(m => (
            <MessageRow key={m.id} message={m} now={state.now} onReply={setReplyTo} />
          ))}
          {stream !== null && (
            <div className="chat__row">
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
                  <p className="bubble__text">{stream.text}</p>
                ) : (
                  <p className="chat__thinking">
                    BigDad думает<span className="chat__dots"><i /><i /><i /></span>
                  </p>
                )}
              </div>
            </div>
          )}
          {waiting && stream === null && (
            <div className="chat__row">
              <span className="chat__ava">
                <SparkIcon size={16} />
              </span>
              <div className="bubble bubble--assistant">
                <p className="chat__thinking">
                  BigDad думает<span className="chat__dots"><i /><i /><i /></span>
                </p>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
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
              <FileIcon size={16} />
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
        </div>
      </section>
    </div>
  )
}

interface ChatReply {
  messageId: string
  snippet: string
}

const MAX_ATTACHMENTS = 5

function MessageRow({
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
        <p className="bubble__text">{message.text}</p>
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
}
