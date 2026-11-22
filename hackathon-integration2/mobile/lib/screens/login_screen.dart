import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/app_scope.dart';
import '../core/config.dart';
import '../core/theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _hidden = true;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Введите логин и пароль');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppScope.of(context).session.login(_email.text, _password.text);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Align(alignment: Alignment.centerLeft, child: RadarLogo(scale: 1.3)),
                    const SizedBox(height: 36),
                    const Text('ВХОД', style: AppText.pageTitle),
                    const SizedBox(height: 8),
                    const Text('Используйте те же логин и пароль, что и на сайте.', style: AppText.subtitle),
                    const SizedBox(height: 28),
                    TextField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.username, AutofillHints.email],
                      decoration: const InputDecoration(labelText: 'Логин (email)'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _password,
                      obscureText: _hidden,
                      textInputAction: TextInputAction.done,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Пароль',
                        suffixIcon: IconButton(
                          tooltip: _hidden ? 'Показать пароль' : 'Скрыть пароль',
                          icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                          onPressed: () => setState(() => _hidden = !_hidden),
                        ),
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!, style: const TextStyle(color: AppColors.level4, fontSize: 13)),
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Text('Войти'),
                    ),
                    const SizedBox(height: 28),
                    Text(
                      'Сервер: ${AppConfig.apiBaseUrl}',
                      textAlign: TextAlign.center,
                      style: AppText.label.copyWith(fontSize: 11),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
