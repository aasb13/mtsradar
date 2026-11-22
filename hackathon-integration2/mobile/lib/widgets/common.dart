import 'package:flutter/material.dart';

import '../core/theme.dart';

/// Плашка «МТС / РАДАР» из макета.
class RadarLogo extends StatelessWidget {
  const RadarLogo({super.key, this.scale = 1});

  final double scale;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      color: Colors.white,
      fontSize: 11 * scale,
      fontWeight: FontWeight.w700,
      height: 1.05,
      letterSpacing: 0.3,
    );
    return Container(
      width: 78 * scale,
      padding: EdgeInsets.fromLTRB(6 * scale, 5 * scale, 6 * scale, 5 * scale),
      color: AppColors.brand,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('МТС', style: style),
          Text('РАДАР', style: style, textAlign: TextAlign.right),
        ],
      ),
    );
  }
}

/// Белый кружок с числом (счётчик в шапке колонки).
class CountBadge extends StatelessWidget {
  const CountBadge(this.count, {super.key});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 24),
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      alignment: Alignment.center,
      decoration: const ShapeDecoration(color: Colors.white, shape: StadiumBorder()),
      child: Text(
        '$count',
        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.text),
      ),
    );
  }
}

/// «Подпись: значение» в одну строку.
class LabelValue extends StatelessWidget {
  const LabelValue(this.label, this.value, {super.key, this.valueColor});

  final String label;
  final String value;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(text: '$label: ', style: AppText.label),
          TextSpan(
            text: value,
            style: AppText.value.copyWith(color: valueColor),
          ),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }
}

/// Пустое состояние / ошибка по центру.
class CenterMessage extends StatelessWidget {
  const CenterMessage({super.key, required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 32, color: AppColors.muted),
            const SizedBox(height: 10),
            Text(text, textAlign: TextAlign.center, style: AppText.subtitle),
            if (action != null) ...[const SizedBox(height: 12), action!],
          ],
        ),
      ),
    );
  }
}
