import 'package:flutter/material.dart';

import '../core/models.dart';
import '../core/theme.dart';
import 'common.dart';
import 'incident_card.dart';

/// Колонка уровня из макета: цветная шапка «4 уровень» со счётчиком, серое тело со списком.
class LevelColumn extends StatelessWidget {
  const LevelColumn({
    super.key,
    required this.level,
    required this.items,
    required this.now,
    required this.onRefresh,
    required this.onOpen,
  });

  final int level;
  final List<Incident> items;
  final DateTime now;
  final Future<void> Function() onRefresh;
  final void Function(Incident) onOpen;

  @override
  Widget build(BuildContext context) {
    final color = AppColors.forLevel(level);
    return Container(
      decoration: BoxDecoration(
        color: AppColors.column,
        borderRadius: BorderRadius.circular(16),
        boxShadow: const [BoxShadow(color: Color(0x12000000), blurRadius: 8, offset: Offset(0, 2))],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Container(
            color: color,
            padding: const EdgeInsets.fromLTRB(14, 12, 12, 18),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '$level уровень',
                    style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                ),
                CountBadge(items.length),
              ],
            ),
          ),
          // светлая «подложка» со скруглением, наезжающая на цветную шапку, как в макете
          Expanded(
            child: Transform.translate(
              offset: const Offset(0, -8),
              child: Container(
                decoration: const BoxDecoration(
                  color: AppColors.column,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
                ),
                child: RefreshIndicator(
                  color: color,
                  onRefresh: onRefresh,
                  child: items.isEmpty
                      ? ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          children: const [
                            SizedBox(height: 80),
                            CenterMessage(icon: Icons.check_circle_outline, text: 'Инцидентов нет'),
                          ],
                        )
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(8, 10, 8, 24),
                          itemCount: items.length,
                          separatorBuilder: (_, _) => const SizedBox(height: 10),
                          itemBuilder: (_, i) =>
                              IncidentCard(incident: items[i], now: now, onTap: () => onOpen(items[i])),
                        ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
