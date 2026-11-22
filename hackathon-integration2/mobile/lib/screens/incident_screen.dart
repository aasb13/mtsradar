import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api.dart';
import '../core/app_scope.dart';
import '../core/config.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

/// Карточка инцидента — только просмотр. Обновляется сама, если инцидент изменился.
class IncidentScreen extends StatefulWidget {
  const IncidentScreen({super.key, required this.incidentId});

  final String incidentId;

  @override
  State<IncidentScreen> createState() => _IncidentScreenState();
}

class _IncidentScreenState extends State<IncidentScreen> {
  IncidentDetail? _detail;
  String? _error;
  StreamSubscription<Map<String, dynamic>>? _sub;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sub != null) return;
    final scope = AppScope.of(context);
    _sub = scope.realtime.events.listen((e) {
      final payload = e['payload'];
      if (payload is Map && payload['incidentId'] == widget.incidentId) _load();
    });
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final json = await AppScope.of(context).api.get('/api/incidents/${Uri.encodeComponent(widget.incidentId)}');
      if (!mounted) return;
      setState(() {
        _detail = IncidentDetail.fromJson((json as Map).cast<String, dynamic>());
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.status == 404 ? 'Инцидент не найден или больше не доступен вам' : e.message);
    }
  }

  Future<void> _openItsm(String url) async {
    // Бэкенд отдаёт ITSM_BASE_URL (обычно localhost). На телефоне заменяем хост
    // на адрес API, иначе ссылка откроется на самом устройстве.
    final ok = await launchUrl(AppConfig.resolveServerUrl(url), mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Не удалось открыть ссылку')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.incidentId),
        shape: const Border(bottom: BorderSide(color: AppColors.line)),
      ),
      body: detail == null
          ? (_error != null
                ? CenterMessage(
                    icon: Icons.error_outline,
                    text: _error!,
                    action: OutlinedButton(onPressed: _load, child: const Text('Повторить')),
                  )
                : const Center(child: CircularProgressIndicator(color: AppColors.level4)))
          : RefreshIndicator(
              color: AppColors.level4,
              onRefresh: _load,
              child: _Body(detail: detail, now: AppScope.of(context).store.now(), onOpenItsm: _openItsm),
            ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.detail, required this.now, required this.onOpenItsm});

  final IncidentDetail detail;
  final DateTime now;
  final void Function(String) onOpenItsm;

  @override
  Widget build(BuildContext context) {
    final c = detail.card;
    final color = AppColors.forLevel(c.priorityId);
    final where = [
      c.productName,
      c.service?.replaceFirst(RegExp(r'^\[[^\]]*\]\s*'), ''),
      c.scenarioName,
    ].whereType<String>().where((s) => s.isNotEmpty).join(' › ');
    final slaColor = AppColors.forSla(c.sla.state);
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
      children: [
        Row(
          children: [
            _Tag('${c.priorityId} уровень · ${c.priority}', color, Colors.white),
            const SizedBox(width: 6),
            _Tag(c.state, AppColors.chip, AppColors.text),
            if (c.isNewCritical) ...[const SizedBox(width: 6), const _Tag('новый', AppColors.level4, Colors.white)],
          ],
        ),
        const SizedBox(height: 12),
        Text(c.header, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, height: 1.25)),
        if (where.isNotEmpty) ...[const SizedBox(height: 6), Text(where, style: AppText.subtitle)],
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: _Metric(
                'Срок',
                c.isResolved ? (c.sla.met == false ? 'нарушен' : 'решён') : formatTimeLeft(c.deadline, now),
                c.isResolved ? AppColors.success : slaColor,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _Metric(
                'Возраст',
                c.submitDate == null ? '—' : formatDuration(now.difference(c.submitDate!)),
                AppColors.text,
              ),
            ),
          ],
        ),
        if (c.aiSummary != null && c.aiSummary!.isNotEmpty) ...[
          const SizedBox(height: 18),
          const Text('ИИ-СВОДКА', style: AppText.section),
          const SizedBox(height: 6),
          Text(c.aiSummary!, style: const TextStyle(fontSize: 14, height: 1.45)),
        ],
        _Section('ОПИСАНИЕ', [
          if (detail.text('description') != null)
            Text(detail.text('description')!, style: const TextStyle(fontSize: 14, height: 1.45))
          else if (c.shortDescription != null)
            Text(c.shortDescription!, style: const TextStyle(fontSize: 14, height: 1.45)),
        ]),
        _Section('КТО', [
          _Row('Команда', c.assignedGroupName),
          _Row('Исполнитель', c.assignedEmployee),
          _Row('Инициатор', detail.text('initiatorName')),
          _Row('Канал', detail.text('receivingChannel')),
        ]),
        _Section('ВРЕМЯ', [
          _Row('Создан', formatDateTime(c.submitDate, withYear: true)),
          _Row('Срок решения', c.deadline == null ? 'не задан' : formatDateTime(c.deadline, withYear: true)),
          if (c.completionDate != null) _Row('Решён', formatDateTime(c.completionDate, withYear: true)),
        ]),
        _Section('СЕРЬЁЗНОСТЬ', [
          _Row('Приоритет', c.priority),
          _Row('Влияние', detail.text('impact')),
          _Row('Срочность', detail.text('urgency')),
          _Row('Тип сервиса', c.serviceType),
        ]),
        if (detail.text('solution') != null)
          _Section('РЕШЕНИЕ', [Text(detail.text('solution')!, style: const TextStyle(fontSize: 14, height: 1.45))]),
        if (c.itsmUrl != null) ...[
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () => onOpenItsm(c.itsmUrl!),
            icon: const Icon(Icons.open_in_new_rounded, size: 18),
            label: const Text('Открыть в ITSM'),
          ),
        ],
      ],
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.background, this.foreground);

  final String text;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(12)),
      child: Text(
        text,
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: foreground),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric(this.label, this.value, this.color);

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: AppColors.column, borderRadius: BorderRadius.circular(10)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: AppText.label),
          const SizedBox(height: 4),
          Text(
            value,
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: color),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.children);

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final visible = children.where((w) => w is! _Row || w.value != null).toList();
    if (visible.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: AppText.section),
          const SizedBox(height: 8),
          ...visible,
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);

  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 120, child: Text(label, style: AppText.label.copyWith(fontSize: 13))),
          Expanded(child: Text(value ?? '—', style: const TextStyle(fontSize: 13, height: 1.35))),
        ],
      ),
    );
  }
}
