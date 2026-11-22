import 'package:flutter/material.dart';

import 'core/api.dart';
import 'core/app_scope.dart';
import 'core/incidents_store.dart';
import 'core/push.dart';
import 'core/realtime.dart';
import 'core/session.dart';
import 'core/theme.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'widgets/common.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final api = ApiClient();
  final session = Session(api);
  final push = PushService(api);
  await push.init(); // без ключей Firebase ничего не делает
  runApp(RadarApp(api: api, session: session, store: IncidentsStore(api), realtime: Realtime(api), push: push));
  session.restore();
}

class RadarApp extends StatelessWidget {
  const RadarApp({
    super.key,
    required this.api,
    required this.session,
    required this.store,
    required this.realtime,
    required this.push,
  });

  final ApiClient api;
  final Session session;
  final IncidentsStore store;
  final Realtime realtime;
  final PushService push;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      api: api,
      session: session,
      store: store,
      realtime: realtime,
      push: push,
      child: MaterialApp(
        title: 'МТС Радар',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: ListenableBuilder(
          listenable: session,
          builder: (_, _) => switch (session.state) {
            SessionState.loading => const _Splash(),
            SessionState.loggedOut => const LoginScreen(),
            SessionState.loggedIn => const HomeScreen(),
          },
        ),
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: RadarLogo(scale: 1.6)));
  }
}
