import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'models.dart';

/// Текущие инциденты пользователя по уровням 4 → 1 + счётчик непрочитанных уведомлений.
///
/// Первичная загрузка — GET /api/my/incidents (бэкенд уже отфильтровал: разработчик видит
/// только свои). Дальше список обновляется событиями WebSocket без перезапроса.
class IncidentsStore extends ChangeNotifier {
  IncidentsStore(this.api);

  final ApiClient api;

  static const levelIds = [4, 3, 2, 1];

  final Map<int, List<Incident>> _byLevel = {for (final p in levelIds) p: <Incident>[]};
  final Map<int, String> _names = {4: 'Наивысший', 3: 'Высокий', 2: 'Средний', 1: 'Низкий'};

  bool loading = false;
  bool loadedOnce = false;
  String? error;
  int unread = 0;

  /// Поправка на часы телефона: serverTime - DateTime.now().
  Duration _offset = Duration.zero;
  Timer? _clock;

  DateTime now() => DateTime.now().add(_offset);

  List<Incident> itemsOf(int level) => _byLevel[level] ?? const [];

  String levelName(int level) => _names[level] ?? '';

  int get total => _byLevel.values.fold(0, (sum, l) => sum + l.length);

  Incident? find(String id) {
    for (final list in _byLevel.values) {
      for (final i in list) {
        if (i.id == id) return i;
      }
    }
    return null;
  }

  /// Раз в 30 секунд перерисовываем «осталось …».
  void startClock() {
    _clock ??= Timer.periodic(const Duration(seconds: 30), (_) => notifyListeners());
  }

  Future<void> load() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      final json = (await api.get('/api/my/incidents') as Map).cast<String, dynamic>();
      final serverTime = DateTime.tryParse('${json['serverTime']}');
      if (serverTime != null) _offset = serverTime.difference(DateTime.now());
      for (final p in levelIds) {
        _byLevel[p] = <Incident>[];
      }
      for (final raw in (json['levels'] as List? ?? const [])) {
        final level = Level.fromJson((raw as Map).cast<String, dynamic>());
        _byLevel[level.priorityId] = level.items..sort(Incident.compare);
        if (level.name.isNotEmpty) _names[level.priorityId] = level.name;
      }
      loadedOnce = true;
      await loadUnread();
    } on ApiException catch (e) {
      error = e.message;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> loadUnread() async {
    try {
      final json = (await api.get('/api/notifications', query: {'unreadOnly': 'true', 'limit': '1'}) as Map);
      unread = (json['unread'] as int?) ?? 0;
      notifyListeners();
    } on ApiException {
      // счётчик не критичен
    }
  }

  /// События WebSocket (формат: {type, payload}).
  void handleEvent(Map<String, dynamic> event) {
    final type = event['type'] as String? ?? '';
    final payload = (event['payload'] as Map?)?.cast<String, dynamic>() ?? const {};
    switch (type) {
      case 'incident.created':
      case 'incident.updated':
      case 'incident.acknowledged':
      case 'incident.ai_updated':
      case 'incident.members_changed':
      case 'incident.sla':
        final card = payload['card'];
        if (card is Map) _upsert(Incident.fromJson(card.cast<String, dynamic>()));
      case 'incident.removed':
        _remove(payload['incidentId'] as String?);
        notifyListeners();
      case 'notification.created':
        unread += 1;
        notifyListeners();
    }
  }

  void _upsert(Incident incident) {
    _remove(incident.id);
    // в приложении только текущие: решённые/закрытые убираем из списка
    if (incident.isActive) {
      final list = _byLevel.putIfAbsent(incident.priorityId, () => <Incident>[]);
      list
        ..add(incident)
        ..sort(Incident.compare);
    }
    notifyListeners();
  }

  void _remove(String? id) {
    if (id == null) return;
    for (final list in _byLevel.values) {
      list.removeWhere((i) => i.id == id);
    }
  }

  void markAllRead() {
    unread = 0;
    notifyListeners();
  }

  void clear() {
    for (final p in levelIds) {
      _byLevel[p] = <Incident>[];
    }
    unread = 0;
    loadedOnce = false;
    error = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }
}
