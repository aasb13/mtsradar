/// Модели ответов бэкенда (формат карточки описан в docs/FRONTEND_API.md бэкенда).
DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;
String? _str(Object? v) => v?.toString();
int _int(Object? v, [int fallback = 0]) => v is int ? v : int.tryParse('$v') ?? fallback;

class AppUser {
  AppUser({required this.id, required this.email, required this.fullName, required this.role, this.itsmLogin});

  final String id;
  final String email;
  final String fullName;
  final String role;
  final String? itsmLogin;

  bool get isDeveloper => role == 'developer';

  String get initials {
    final parts = fullName.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return email.isNotEmpty ? email[0].toUpperCase() : '?';
    return parts.take(2).map((p) => p[0].toUpperCase()).join();
  }

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
    id: j['id'] as String,
    email: (j['email'] ?? '') as String,
    fullName: (j['fullName'] ?? j['email'] ?? '') as String,
    role: (j['role'] ?? 'viewer') as String,
    itsmLogin: _str(j['itsmLogin']),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'email': email,
    'fullName': fullName,
    'role': role,
    'itsmLogin': itsmLogin,
  };
}

class Sla {
  const Sla({required this.state, this.timeLeftSeconds, this.met});

  final String state; // ok | warning | danger | breached | none | resolved
  final int? timeLeftSeconds;
  final bool? met;

  factory Sla.fromJson(Map<String, dynamic>? j) => Sla(
    state: (j?['state'] ?? 'none') as String,
    timeLeftSeconds: j?['timeLeftSeconds'] as int?,
    met: j?['met'] as bool?,
  );
}

/// Карточка инцидента: одинакова в REST и в событиях WebSocket.
class Incident {
  Incident({
    required this.id,
    required this.header,
    required this.priorityId,
    required this.priority,
    required this.stateId,
    required this.state,
    required this.sla,
    this.shortDescription,
    this.productName,
    this.service,
    this.scenarioName,
    this.serviceType,
    this.assignedGroupName,
    this.assignedEmployee,
    this.submitDate,
    this.deadline,
    this.completionDate,
    this.isActive = true,
    this.isResolved = false,
    this.isCritical = false,
    this.isNewCritical = false,
    this.itsmUrl,
    this.aiSummary,
  });

  final String id;
  final String header;
  final String? shortDescription;
  final String? productName;
  final String? service;
  final String? scenarioName;
  final String? serviceType;
  final int priorityId;
  final String priority;
  final int stateId;
  final String state;
  final String? assignedGroupName;
  final String? assignedEmployee;
  final DateTime? submitDate;
  final DateTime? deadline;
  final DateTime? completionDate;
  final bool isActive;
  final bool isResolved;
  final bool isCritical;
  final bool isNewCritical;
  final Sla sla;
  final String? itsmUrl;
  final String? aiSummary;

  factory Incident.fromJson(Map<String, dynamic> j) {
    final ai = j['ai'];
    return Incident(
      id: j['id'] as String,
      header: (j['header'] ?? '') as String,
      shortDescription: _str(j['shortDescription']),
      productName: _str(j['productName']),
      service: _str(j['service']),
      scenarioName: _str(j['scenarioName']),
      serviceType: _str(j['serviceType']),
      priorityId: _int(j['priorityId'], 1),
      priority: (j['priority'] ?? '') as String,
      stateId: _int(j['stateId']),
      state: (j['state'] ?? '') as String,
      assignedGroupName: _str(j['assignedGroupName']),
      assignedEmployee: _str(j['assignedEmployee']),
      submitDate: _date(j['submitDate']),
      deadline: _date(j['deadline']),
      completionDate: _date(j['completionDate']),
      isActive: j['isActive'] != false,
      isResolved: j['isResolved'] == true,
      isCritical: j['isCritical'] == true,
      isNewCritical: j['isNewCritical'] == true,
      sla: Sla.fromJson(j['sla'] as Map<String, dynamic>?),
      itsmUrl: _str(j['itsmUrl']),
      aiSummary: ai is Map ? _str(ai['summary']) : null,
    );
  }

  static const _slaRank = {'breached': 0, 'danger': 1, 'warning': 2, 'ok': 3, 'none': 4, 'resolved': 5};

  /// Как на бэкенде: критические и близкие к просрочке — сверху.
  static int compare(Incident a, Incident b) {
    int cmpBool(bool x, bool y) => x == y ? 0 : (x ? 1 : -1);
    var r = cmpBool(a.isResolved, b.isResolved);
    if (r != 0) return r;
    r = cmpBool(!a.isCritical, !b.isCritical);
    if (r != 0) return r;
    r = (_slaRank[a.sla.state] ?? 9).compareTo(_slaRank[b.sla.state] ?? 9);
    if (r != 0) return r;
    final da = a.deadline?.millisecondsSinceEpoch ?? 1 << 62;
    final db = b.deadline?.millisecondsSinceEpoch ?? 1 << 62;
    return da.compareTo(db);
  }
}

/// Полная карточка: GET /api/incidents/{id}. Поле data — исходная запись выгрузки.
class IncidentDetail {
  IncidentDetail(this.card, this.data);

  final Incident card;
  final Map<String, dynamic> data;

  String? text(String key) {
    final v = data[key];
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty || s == 'Нет' ? null : s;
  }

  factory IncidentDetail.fromJson(Map<String, dynamic> j) =>
      IncidentDetail(Incident.fromJson(j), (j['data'] as Map?)?.cast<String, dynamic>() ?? const {});
}

class Level {
  Level({required this.priorityId, required this.title, required this.name, required this.items});

  final int priorityId;
  final String title;
  final String name;
  final List<Incident> items;

  factory Level.fromJson(Map<String, dynamic> j) => Level(
    priorityId: _int(j['priorityId'], 1),
    title: (j['title'] ?? '') as String,
    name: (j['name'] ?? '') as String,
    items: ((j['items'] as List?) ?? const [])
        .map((e) => Incident.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
  );
}

class AppNotification {
  AppNotification({
    required this.id,
    required this.kind,
    required this.severity,
    required this.title,
    this.body,
    this.incidentId,
    this.createdAt,
    this.readAt,
  });

  final String id;
  final String kind;
  final String severity; // critical | high | info | success
  final String title;
  final String? body;
  final String? incidentId;
  final DateTime? createdAt;
  final DateTime? readAt;

  bool get isRead => readAt != null;

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
    id: j['id'] as String,
    kind: (j['kind'] ?? '') as String,
    severity: (j['severity'] ?? 'info') as String,
    title: (j['title'] ?? '') as String,
    body: _str(j['body']),
    incidentId: _str(j['incidentId']),
    createdAt: _date(j['createdAt']),
    readAt: _date(j['readAt']),
  );
}
