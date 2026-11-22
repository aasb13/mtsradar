import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import '../core/app_scope.dart';
import '../core/format.dart';
import '../core/incidents_store.dart';
import '../core/models.dart';
import '../core/realtime.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import '../widgets/level_column.dart';
import 'incident_screen.dart';
import 'notifications_screen.dart';

/// Главный экран: инциденты по уровням 4 → 1.
/// Телефон — колонки листаются свайпом; планшет/широкий экран — все четыре рядом, как на сайте.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _pages = PageController(viewportFraction: 0.92);
  int _page = 0;
  final _subs = <StreamSubscription<dynamic>>[];
  bool _started = false;

  late final Realtime _realtime;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // запуск после первого кадра: загрузка дёргает слушателей, во время build этого делать нельзя
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) _realtime = AppScope.of(context).realtime;
    _started = true;
  }

  void _start() {
    if (!mounted) return;
    final scope = AppScope.of(context);
    scope.store
      ..clear() // данные предыдущего пользователя, если он был
      ..startClock()
      ..load();
    scope.realtime.start();
    _subs.add(scope.realtime.events.listen(_onEvent));
    _subs.add(scope.push.opened.listen(_openIncidentById));
    _subs.add(scope.push.foreground.listen(_onForegroundPush));
    scope.push.registerForCurrentUser();
    final initial = scope.push.initialIncidentId;
    if (initial != null) {
      scope.push.initialIncidentId = null;
      _openIncidentById(initial);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    for (final s in _subs) {
      s.cancel();
    }
    _realtime.stop(); // выход или истёкшая сессия: при следующем входе подключимся заново
    _pages.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      final scope = AppScope.of(context);
      scope.realtime.reconnectNow();
      scope.store.load(); // пока приложение было в фоне, события по WebSocket не приходили
    }
  }

  void _onEvent(Map<String, dynamic> event) {
    final store = AppScope.of(context).store;
    if (event['type'] == '_connected') {
      if (store.loadedOnce) store.load();
      return;
    }
    store.handleEvent(event);
    if (event['type'] == 'notification.created') {
      final n = AppNotification.fromJson((event['payload'] as Map).cast<String, dynamic>());
      _showBanner(n.title, n.body, n.severity, n.incidentId);
    }
  }

  /// Push при открытом приложении: если WebSocket подключён, баннер уже показан по нему.
  void _onForegroundPush(RemoteMessage m) {
    if (AppScope.of(context).realtime.connected.value) return;
    final n = m.notification;
    if (n == null) return;
    _showBanner(
      n.title ?? 'Уведомление',
      n.body,
      m.data['severity'] as String? ?? 'info',
      m.data['incidentId'] as String?,
    );
  }

  void _showBanner(String title, String? body, String severity, String? incidentId) {
    if (!mounted) return;
    final color = switch (severity) {
      'critical' => AppColors.level4,
      'high' => AppColors.level3,
      'success' => AppColors.success,
      _ => AppColors.text,
    };
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          backgroundColor: color,
          duration: const Duration(seconds: 6),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(fontWeight: FontWeight.w600, color: Colors.white),
              ),
              if (body != null && body.isNotEmpty)
                Text(
                  body,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white),
                ),
            ],
          ),
          action: incidentId == null
              ? null
              : SnackBarAction(
                  label: 'Открыть',
                  textColor: Colors.white,
                  onPressed: () => _openIncidentById(incidentId),
                ),
        ),
      );
  }

  void _openIncidentById(String id) {
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => IncidentScreen(incidentId: id)));
  }

  void _openNotifications() {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const NotificationsScreen()));
  }

  void _openProfile() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Colors.white,
      builder: (_) => const _ProfileSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final user = scope.session.user;
    final isDev = user?.isDeveloper ?? false;
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: const RadarLogo(),
        shape: const Border(bottom: BorderSide(color: AppColors.line)),
        actions: [
          ListenableBuilder(
            listenable: scope.store,
            builder: (_, _) => IconButton(
              tooltip: 'Уведомления',
              onPressed: _openNotifications,
              icon: Badge(
                isLabelVisible: scope.store.unread > 0,
                backgroundColor: AppColors.level4,
                label: Text('${scope.store.unread}'),
                child: const Icon(Icons.notifications_none_rounded),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 12, left: 4),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _openProfile,
              child: CircleAvatar(
                radius: 17,
                backgroundColor: const Color(0xFFE3E7FF),
                child: Text(
                  user?.initials ?? '?',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF4C5BD4)),
                ),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(isDev ? 'МОИ ИНЦИДЕНТЫ' : 'КРИТИЧНОСТЬ', style: AppText.pageTitle),
                  const SizedBox(height: 6),
                  Text(
                    isDev
                        ? 'Инциденты, в которые вас добавили. Нажмите на карточку, чтобы посмотреть детали.'
                        : 'Все текущие инциденты по уровням. Нажмите на карточку, чтобы посмотреть детали.',
                    style: AppText.subtitle,
                  ),
                  const SizedBox(height: 6),
                  const _ConnectionLine(),
                ],
              ),
            ),
            Expanded(
              child: ListenableBuilder(listenable: scope.store, builder: (context, _) => _buildBoard(scope.store)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBoard(IncidentsStore store) {
    if (!store.loadedOnce) {
      if (store.error != null) {
        return CenterMessage(
          icon: Icons.cloud_off_outlined,
          text: store.error!,
          action: OutlinedButton(onPressed: store.load, child: const Text('Повторить')),
        );
      }
      return const Center(child: CircularProgressIndicator(color: AppColors.level4));
    }
    final now = store.now();
    Widget column(int level) => LevelColumn(
      level: level,
      items: store.itemsOf(level),
      now: now,
      onRefresh: store.load,
      onOpen: (i) => _openIncidentById(i.id),
    );

    return LayoutBuilder(
      builder: (context, c) {
        if (c.maxWidth >= 900) {
          // планшет / широкий экран: четыре колонки рядом, как на сайте
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final (i, level) in IncidentsStore.levelIds.indexed) ...[
                  if (i > 0) const SizedBox(width: 16),
                  Expanded(child: column(level)),
                ],
              ],
            ),
          );
        }
        return Column(
          children: [
            _LevelTabs(
              selected: _page,
              counts: [for (final l in IncidentsStore.levelIds) store.itemsOf(l).length],
              onSelect: (i) =>
                  _pages.animateToPage(i, duration: const Duration(milliseconds: 250), curve: Curves.easeOut),
            ),
            Expanded(
              child: PageView.builder(
                controller: _pages,
                itemCount: IncidentsStore.levelIds.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (_, i) =>
                    Padding(padding: const EdgeInsets.fromLTRB(6, 4, 6, 12), child: column(IncidentsStore.levelIds[i])),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Переключатель уровней над колонками (телефон).
class _LevelTabs extends StatelessWidget {
  const _LevelTabs({required this.selected, required this.counts, required this.onSelect});

  final int selected;
  final List<int> counts;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 46,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
        itemCount: IncidentsStore.levelIds.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final level = IncidentsStore.levelIds[i];
          final color = AppColors.forLevel(level);
          final active = i == selected;
          return InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: () => onSelect(i),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: active ? color : AppColors.chip,
                borderRadius: BorderRadius.circular(18),
              ),
              child: Text(
                '$level ур. · ${counts[i]}',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: active ? Colors.white : AppColors.text,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// «● онлайн» / «переподключение…» — видно, живые ли данные.
class _ConnectionLine extends StatelessWidget {
  const _ConnectionLine();

  @override
  Widget build(BuildContext context) {
    final realtime = AppScope.of(context).realtime;
    return ValueListenableBuilder<bool>(
      valueListenable: realtime.connected,
      builder: (_, online, _) => Row(
        children: [
          Icon(Icons.circle, size: 8, color: online ? AppColors.success : AppColors.muted),
          const SizedBox(width: 6),
          Text(online ? 'обновляется в реальном времени' : 'подключение…', style: AppText.label),
        ],
      ),
    );
  }
}

class _ProfileSheet extends StatelessWidget {
  const _ProfileSheet();

  Future<void> _logout(BuildContext context) async {
    final scope = AppScope.of(context);
    Navigator.of(context).pop();
    await scope.push.unregister();
    await scope.realtime.stop();
    scope.store.clear();
    await scope.session.logout();
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final user = scope.session.user;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(user?.fullName ?? '', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(user?.email ?? '', style: AppText.subtitle),
            const SizedBox(height: 14),
            LabelValue('Роль', roleNames[user?.role] ?? user?.role ?? ''),
            if (user?.itsmLogin != null) ...[const SizedBox(height: 4), LabelValue('Логин в ITSM', user!.itsmLogin!)],
            const SizedBox(height: 4),
            LabelValue('Push-уведомления', scope.push.enabled ? 'включены' : 'не настроены (только в приложении)'),
            const SizedBox(height: 22),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.level4,
                minimumSize: const Size.fromHeight(46),
                side: const BorderSide(color: AppColors.line),
              ),
              onPressed: () => _logout(context),
              icon: const Icon(Icons.logout_rounded),
              label: const Text('Выйти'),
            ),
          ],
        ),
      ),
    );
  }
}
