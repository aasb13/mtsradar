import 'package:flutter/material.dart';

/// Цвета из макета: уровни критичности 4 → 1.
class AppColors {
  AppColors._();

  static const level4 = Color(0xFFDF263D);
  static const level3 = Color(0xFFDF5169);
  static const level2 = Color(0xFFD77B99);
  static const level1 = Color(0xFFD292BD);

  static const brand = Color(0xFFFF0032); // плашка логотипа
  static const text = Color(0xFF111111);
  static const muted = Color(0xFF8A8A8E);
  static const line = Color(0xFFE5E5E8);
  static const column = Color(0xFFF5F5F6); // фон колонки
  static const chip = Color(0xFFF2F2F4); // кнопки «поиск», чипы
  static const success = Color(0xFF1E8E4E);
  static const warning = Color(0xFFB7791F);

  static Color forLevel(int priorityId) => switch (priorityId) {
    4 => level4,
    3 => level3,
    2 => level2,
    _ => level1,
  };

  /// Цвет срока: просрочен/почти — красный, предупреждение — янтарный, остальное — серый.
  static Color forSla(String state) => switch (state) {
    'breached' || 'danger' => level4,
    'warning' => warning,
    'resolved' => success,
    _ => muted,
  };
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: AppColors.level4, primary: AppColors.level4, surface: Colors.white);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: 'Inter',
    scaffoldBackgroundColor: Colors.white,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: AppColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: 'Inter',
        fontSize: 15,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.4,
        color: AppColors.text,
      ),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.line, thickness: 1, space: 1),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.chip,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: AppColors.level4, width: 1.2),
      ),
      labelStyle: const TextStyle(color: AppColors.muted),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.level4,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontFamily: 'Inter', fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}

class AppText {
  AppText._();

  static const pageTitle = TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: AppColors.text, height: 1.15);
  static const subtitle = TextStyle(fontSize: 14, color: AppColors.muted, height: 1.4);
  static const label = TextStyle(fontSize: 12, color: AppColors.muted);
  static const value = TextStyle(fontSize: 12, color: AppColors.text);
  static const section = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w700,
    letterSpacing: 0.6,
    color: AppColors.muted,
  );
}
