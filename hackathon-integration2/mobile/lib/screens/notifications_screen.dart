import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/app_scope.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/theme.dart';
import '../widgets/common.dart';
import 'incident_screen.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<AppNotification>? _items;
  String? _error;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final json = (await AppScope.of(context).api.get('/api/notifications', query: {'limit': '100'}) as Map);
      if (!mounted) return;
      setState(() {
        _items = ((json['items'] as List?) ?? const [])
            .map((e) => AppNotification.fromJson((e as Map).cast<String, dynamic>()))
            .toList();
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _readAll() async {
    final scope = AppScope.of(context);
    try {
      await scope.api.post('/api/notifications/read-all');
      scope.store.markAllRead();
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _open(AppNotification n) async {
    final scope = AppScope.of(context);
    if (!n.isRead) {
      try {
        await scope.api.post('/api/notifications/${n.id}/read');
        await scope.store.loadUnread();
      } catch (_) {}
    }
    if (!mounted || n.incidentId == null) return;
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => IncidentScreen(incidentId: n.incidentId!)));
    _load();
  }

  Color _dot(String severity) => switch (severity) {
    'critical' => AppColors.level4,
    'high' => AppColors.level3,
    'success' => AppColors.success,
    _ => AppColors.muted,
  };

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      appBar: AppBar(
        title: const Text('УВЕДОМЛЕНИЯ'),
        shape: const Border(bottom: BorderSide(color: AppColors.line)),
        actions: [
          TextButton(onPressed: _readAll, child: const Text('Прочитать все')),
          const SizedBox(width: 4),
        ],
      ),
      body: items == null
          ? (_error != null
                ? CenterMessage(icon: Icons.cloud_off_outlined, text: _error!)
                : const Center(child: CircularProgressIndicator(color: AppColors.level4)))
          : RefreshIndicator(
              color: AppColors.level4,
              onRefresh: _load,
              child: items.isEmpty
                  ? ListView(
                      children: const [
                        SizedBox(height: 120),
                        CenterMessage(icon: Icons.notifications_none_rounded, text: 'Уведомлений пока нет'),
                      ],
                    )
                  : ListView.separated(
                      itemCount: items.length,
                      separatorBuilder: (_, _) => const Divider(indent: 20, endIndent: 20),
                      itemBuilder: (_, i) {
                        final n = items[i];
                        return ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
                          leading: Icon(Icons.circle, size: 10, color: n.isRead ? AppColors.line : _dot(n.severity)),
                          minLeadingWidth: 10,
                          title: Text(
                            n.title,
                            style: TextStyle(fontSize: 14, fontWeight: n.isRead ? FontWeight.w400 : FontWeight.w600),
                          ),
                          subtitle: Text(
                            [if (n.body != null) n.body!, formatDateTime(n.createdAt)].join('\n'),
                            style: AppText.label,
                          ),
                          onTap: () => _open(n),
                        );
                      },
                    ),
            ),
    );
  }
}
