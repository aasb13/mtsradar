import 'package:flutter/material.dart';

import '../core/format.dart';
import '../core/models.dart';
import '../core/theme.dart';
import 'common.dart';

/// Карточка как в макете: белая, с цветной полосой слева, номер и приоритет сверху.
class IncidentCard extends StatelessWidget {
  const IncidentCard({super.key, required this.incident, required this.now, this.onTap});

  final Incident incident;
  final DateTime now;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color = AppColors.forLevel(incident.priorityId);
    final slaColor = AppColors.forSla(incident.sla.state);
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 6, offset: Offset(0, 2))],
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        color: Colors.white,
        child: InkWell(
          onTap: onTap,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(width: 5, color: color),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('#${incident.id}', style: AppText.label.copyWith(fontSize: 11))),
                            if (incident.isNewCritical) ...[
                              const _Pill('новый', AppColors.level4),
                              const SizedBox(width: 6),
                            ],
                            Text(
                              incident.priority,
                              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: AppColors.text),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          incident.header,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            color: AppColors.text,
                            height: 1.25,
                          ),
                        ),
                        const SizedBox(height: 4),
                        LabelValue('Продукт', incident.productName ?? '—'),
                        const SizedBox(height: 1),
                        LabelValue('Статус', incident.state),
                        const SizedBox(height: 1),
                        LabelValue(
                          'Срок',
                          incident.deadline == null
                              ? 'не задан'
                              : '${formatDateTime(incident.deadline)} · ${formatTimeLeft(incident.deadline, now)}',
                          valueColor: incident.deadline == null ? null : slaColor,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text, this.color);

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
      child: Text(
        text,
        style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: Colors.white),
      ),
    );
  }
}
