/// Форматирование дат и длительностей без сторонних пакетов.
String two(int v) => v.toString().padLeft(2, '0');

/// 10.11 15:32 (местное время телефона).
String formatDateTime(DateTime? dt, {bool withYear = false}) {
  if (dt == null) return '—';
  final l = dt.toLocal();
  final date = withYear ? '${two(l.day)}.${two(l.month)}.${l.year}' : '${two(l.day)}.${two(l.month)}';
  return '$date ${two(l.hour)}:${two(l.minute)}';
}

/// 3 д 4 ч · 2 ч 10 мин · 15 мин
String formatDuration(Duration d) {
  var minutes = d.inMinutes.abs();
  final days = minutes ~/ (24 * 60);
  minutes -= days * 24 * 60;
  final hours = minutes ~/ 60;
  minutes -= hours * 60;
  if (days > 0) return hours > 0 ? '$days д $hours ч' : '$days д';
  if (hours > 0) return minutes > 0 ? '$hours ч $minutes мин' : '$hours ч';
  return '$minutes мин';
}

/// «осталось 2 ч 10 мин» / «просрочен на 3 д» относительно [now].
String formatTimeLeft(DateTime? deadline, DateTime now) {
  if (deadline == null) return 'срок не задан';
  final left = deadline.difference(now);
  return left.isNegative ? 'просрочен на ${formatDuration(left)}' : 'осталось ${formatDuration(left)}';
}

const roleNames = {
  'admin': 'Администратор',
  'coordinator': 'Координатор',
  'viewer': 'Наблюдатель',
  'developer': 'Разработчик',
};
