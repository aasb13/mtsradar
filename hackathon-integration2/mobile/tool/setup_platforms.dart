// Настройка android/ и ios/ после `flutter create`. Запуск из корня проекта:
//   dart run tool/setup_platforms.dart
//
// Что делает (повторный запуск безопасен — ничего не задвоит):
//   Android: разрешения INTERNET и POST_NOTIFICATIONS, http к локальному бэкенду
//            (usesCleartextTraffic), название «МТС Радар», minSdk не ниже 24.
//   iOS:     название «МТС Радар», разрешение http к локальному бэкенду (ATS),
//            фоновый режим remote-notification для push.
import 'dart:io';

const appTitle = 'МТС Радар';

void main() {
  var ok = true;
  ok &= _patchAndroidManifest(File('android/app/src/main/AndroidManifest.xml'));
  ok &= _patchGradle();
  ok &= _patchInfoPlist(File('ios/Runner/Info.plist'));
  stdout.writeln(ok ? '\nГотово.' : '\nЕсть предупреждения — см. выше.');
  if (!ok) exitCode = 1;
}

bool _patchAndroidManifest(File f) {
  if (!f.existsSync()) {
    stdout.writeln('! ${f.path} не найден — сначала выполните flutter create (см. README)');
    return false;
  }
  var s = f.readAsStringSync();
  final before = s;
  for (final perm in ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS']) {
    if (!s.contains('"$perm"')) {
      final tag = _firstMatch(s, r'<manifest[^>]*>');
      s = s.replaceFirst(tag, '$tag\n    <uses-permission android:name="$perm"/>');
    }
  }
  s = s.replaceFirst(RegExp(r'android:label="[^"]*"'), 'android:label="$appTitle"');
  if (!s.contains('android:usesCleartextTraffic')) {
    s = s.replaceFirst('<application', '<application\n        android:usesCleartextTraffic="true"');
  }
  return _write(f, before, s);
}

bool _patchGradle() {
  final kts = File('android/app/build.gradle.kts');
  final groovy = File('android/app/build.gradle');
  final f = kts.existsSync() ? kts : groovy;
  if (!f.existsSync()) {
    stdout.writeln('! android/app/build.gradle(.kts) не найден');
    return false;
  }
  var s = f.readAsStringSync();
  final before = s;
  if (f == kts) {
    s = s.replaceFirst('minSdk = flutter.minSdkVersion', 'minSdk = maxOf(flutter.minSdkVersion, 24)');
  } else {
    s = s.replaceFirst(
      RegExp(r'minSdk(Version)? flutter\.minSdkVersion'),
      'minSdkVersion Math.max(flutter.minSdkVersion, 24)',
    );
  }
  if (!s.contains('24)')) {
    stdout.writeln('! В ${f.path} не нашлась строка minSdk — проверьте вручную, что minSdk не ниже 24');
  }
  return _write(f, before, s);
}

bool _patchInfoPlist(File f) {
  if (!f.existsSync()) {
    stdout.writeln('- ${f.path} не найден — iOS пропущен (это нормально, если собираете только Android)');
    return true;
  }
  var s = f.readAsStringSync();
  final before = s;
  s = s.replaceFirst(
    RegExp(r'(<key>CFBundleDisplayName</key>\s*<string>)[^<]*(</string>)'),
    '${_firstMatch(s, r'<key>CFBundleDisplayName</key>\s*<string>')}$appTitle</string>',
  );
  final extra = StringBuffer();
  if (!s.contains('NSAppTransportSecurity')) {
    extra.write(
      '\t<key>NSAppTransportSecurity</key>\n\t<dict>\n'
      '\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t</dict>\n',
    );
  }
  if (!s.contains('UIBackgroundModes')) {
    extra.write('\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>\n\t</array>\n');
  }
  if (extra.isNotEmpty) {
    final end = s.lastIndexOf('</dict>');
    s = '${s.substring(0, end)}$extra${s.substring(end)}';
  }
  return _write(f, before, s);
}

String _firstMatch(String s, String pattern) => RegExp(pattern).firstMatch(s)?.group(0) ?? '';

bool _write(File f, String before, String after) {
  if (before == after) {
    stdout.writeln('= ${f.path}: уже настроен');
  } else {
    f.writeAsStringSync(after);
    stdout.writeln('+ ${f.path}: обновлён');
  }
  return true;
}
