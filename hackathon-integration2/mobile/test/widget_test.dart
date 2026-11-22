// Простые проверки без сервера: `flutter test`.
// Файл называется widget_test.dart специально: `flutter create .` не перезапишет его шаблонным тестом.
import 'package:flutter_test/flutter_test.dart';
import 'package:mts_radar/core/format.dart';
import 'package:mts_radar/core/models.dart';

void main() {
  test('длительности по-русски', () {
    expect(formatDuration(const Duration(days: 3, hours: 4)), '3 д 4 ч');
    expect(formatDuration(const Duration(minutes: 130)), '2 ч 10 мин');
    expect(formatDuration(const Duration(minutes: 5)), '5 мин');
  });

  test('карточка из ответа бэкенда', () {
    final i = Incident.fromJson({
      'id': 'INC000021938167',
      'header': 'Проблема с Прокладка',
      'priorityId': 3,
      'priority': 'Высокий',
      'stateId': 2,
      'state': 'Выполняется',
      'deadline': '2026-11-10T12:32:14Z',
      'sla': {'state': 'breached', 'timeLeftSeconds': -100},
      'isActive': true,
    });
    expect(i.priorityId, 3);
    expect(i.sla.state, 'breached');
    expect(formatTimeLeft(i.deadline, DateTime.utc(2026, 11, 10, 14, 32, 14)), 'просрочен на 2 ч');
  });

  test('сортировка: критические и просроченные сверху', () {
    Incident make(String id, {bool critical = false, String sla = 'ok'}) => Incident.fromJson({
          'id': id,
          'header': id,
          'priorityId': critical ? 4 : 2,
          'priority': '',
          'stateId': 0,
          'state': '',
          'isCritical': critical,
          'sla': {'state': sla},
        });
    final list = [make('a'), make('b', sla: 'breached'), make('c', critical: true)]..sort(Incident.compare);
    expect(list.map((e) => e.id).toList(), ['c', 'b', 'a']);
  });
}
