-- Tobi World Wide schema (PostgreSQL). Safe to run more than once.
-- server.js applies this file automatically on startup.

CREATE TABLE IF NOT EXISTS Universities (
  Id BIGSERIAL PRIMARY KEY,
  Name VARCHAR(250) NOT NULL UNIQUE,
  Category VARCHAR(80),
  State VARCHAR(80),
  SourceUrl VARCHAR(500),
  SourceUpdatedAt TIMESTAMPTZ,
  IsActive BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS StudentProfiles (
  Id BIGSERIAL PRIMARY KEY,
  FullName VARCHAR(120) NOT NULL,
  Email VARCHAR(120) NOT NULL UNIQUE,
  PasswordHash VARCHAR(300) NOT NULL,
  UniversityId BIGINT NOT NULL REFERENCES Universities(Id),
  IsAdmin BOOLEAN NOT NULL DEFAULT FALSE,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ApiSessions (
  Id BIGSERIAL PRIMARY KEY,
  TokenHash VARCHAR(100) NOT NULL UNIQUE,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  ExpiresAt TIMESTAMPTZ NOT NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS StudentMessages (
  Id BIGSERIAL PRIMARY KEY,
  SenderId BIGINT NOT NULL REFERENCES StudentProfiles(Id),
  RecipientId BIGINT NOT NULL REFERENCES StudentProfiles(Id),
  Body VARCHAR(2000) NOT NULL,
  SentAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS PortalAdmins (
  Id BIGSERIAL PRIMARY KEY,
  Username VARCHAR(80) NOT NULL UNIQUE,
  DisplayName VARCHAR(120) NOT NULL,
  Email VARCHAR(120),
  PasswordHash VARCHAR(300) NOT NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS Reporters (
  Id BIGSERIAL PRIMARY KEY,
  Username VARCHAR(80) NOT NULL UNIQUE,
  FullName VARCHAR(120) NOT NULL,
  Email VARCHAR(120) NOT NULL,
  PasswordHash VARCHAR(300) NOT NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ReporterInvites (
  Id BIGSERIAL PRIMARY KEY,
  CodeHash VARCHAR(100) NOT NULL UNIQUE,
  UsedByReporterId BIGINT REFERENCES Reporters(Id),
  UsedAt TIMESTAMPTZ,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS PortalSessions (
  Id BIGSERIAL PRIMARY KEY,
  TokenHash VARCHAR(100) NOT NULL UNIQUE,
  UserType VARCHAR(20) NOT NULL,
  UserId BIGINT NOT NULL,
  ExpiresAt TIMESTAMPTZ NOT NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS SubmittedReports (
  Id BIGSERIAL PRIMARY KEY,
  ReporterId BIGINT NOT NULL REFERENCES Reporters(Id),
  Title VARCHAR(250) NOT NULL,
  Body TEXT NOT NULL,
  Status VARCHAR(30) NOT NULL DEFAULT 'pending',
  SubmittedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
  ReviewedAt TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS NewsArticles (
  Id BIGSERIAL PRIMARY KEY,
  Topic VARCHAR(80) NOT NULL,
  Headline VARCHAR(300) NOT NULL,
  Summary VARCHAR(1000),
  BodyHtml TEXT,
  ReadingMinutes INT,
  School VARCHAR(250),
  SourceUrl VARCHAR(900),
  AuthorId BIGINT,
  PublishedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS PendingNewsArticles (
  Id BIGSERIAL PRIMARY KEY,
  Topic VARCHAR(80) NOT NULL,
  Headline VARCHAR(300) NOT NULL,
  Summary VARCHAR(1000),
  BodyHtml TEXT,
  School VARCHAR(250),
  SourceUrl VARCHAR(900),
  SourceTitle VARCHAR(400),
  SourceHost VARCHAR(200),
  IsOfficialSource BOOLEAN NOT NULL DEFAULT FALSE,
  Status VARCHAR(30) NOT NULL DEFAULT 'pending',
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
  ReviewedAt TIMESTAMPTZ,
  PublishedArticleId BIGINT
);

CREATE TABLE IF NOT EXISTS NewsDeskSettings (
  Id INT NOT NULL PRIMARY KEY,
  AutoPublishOfficial BOOLEAN NOT NULL DEFAULT FALSE,
  UpdatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO NewsDeskSettings (Id, AutoPublishOfficial) VALUES (1, FALSE) ON CONFLICT (Id) DO NOTHING;

-- Student profile and study-guide data
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS Matric VARCHAR(60);
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS Programme VARCHAR(160);
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS Subjects TEXT NOT NULL DEFAULT '[]';
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS AiOutline TEXT;
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS Phone VARCHAR(30);
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS IsSuspended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ReporterInvites ADD COLUMN IF NOT EXISTS Code VARCHAR(20);

-- Help requests from students (admission processing, hostel, NELFUND, scholarship forms, password help)
CREATE TABLE IF NOT EXISTS ServiceRequests (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  Kind VARCHAR(60) NOT NULL,
  Details VARCHAR(1500),
  Status VARCHAR(20) NOT NULL DEFAULT 'new',
  AdminNote VARCHAR(500),
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
  UpdatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Banner messages from the admin (all students, or one university)
CREATE TABLE IF NOT EXISTS Announcements (
  Id BIGSERIAL PRIMARY KEY,
  Message VARCHAR(600) NOT NULL,
  UniversityId BIGINT REFERENCES Universities(Id) ON DELETE CASCADE,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opens and shares per news post
CREATE TABLE IF NOT EXISTS PostStats (
  PostId VARCHAR(40) PRIMARY KEY,
  Views INT NOT NULL DEFAULT 0,
  Shares INT NOT NULL DEFAULT 0
);

-- Past questions / CBT practice
CREATE TABLE IF NOT EXISTS CbtQuestions (
  Id BIGSERIAL PRIMARY KEY,
  Subject VARCHAR(120) NOT NULL,
  Question VARCHAR(700) NOT NULL,
  OptA VARCHAR(300) NOT NULL,
  OptB VARCHAR(300) NOT NULL,
  OptC VARCHAR(300),
  OptD VARCHAR(300),
  Answer CHAR(1) NOT NULL,
  Explanation VARCHAR(700),
  Source VARCHAR(10) NOT NULL DEFAULT 'admin',
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS CbtQuestionsSubject ON CbtQuestions (lower(Subject));

-- Email codes for forgotten passwords
CREATE TABLE IF NOT EXISTS PasswordResets (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  CodeHash VARCHAR(100) NOT NULL,
  ExpiresAt TIMESTAMPTZ NOT NULL,
  Attempts INT NOT NULL DEFAULT 0
);

ALTER TABLE NewsDeskSettings ADD COLUMN IF NOT EXISTS AutoSearch BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE NewsDeskSettings ADD COLUMN IF NOT EXISTS LastAutoRun TIMESTAMPTZ;

-- Campus hub: opportunities (scholarships, SIWES, internships, jobs), personal deadlines, checklist, timetable, notes, market, scam alerts
CREATE TABLE IF NOT EXISTS Opportunities (
  Id BIGSERIAL PRIMARY KEY,
  Kind VARCHAR(20) NOT NULL,
  Title VARCHAR(200) NOT NULL,
  Org VARCHAR(160),
  Location VARCHAR(120),
  Deadline DATE,
  Link VARCHAR(500),
  Details VARCHAR(1500),
  Status VARCHAR(12) NOT NULL DEFAULT 'approved',
  SubmittedBy BIGINT REFERENCES StudentProfiles(Id) ON DELETE SET NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS StudentDeadlines (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  Title VARCHAR(160) NOT NULL,
  Kind VARCHAR(20) NOT NULL DEFAULT 'other',
  DueDate DATE NOT NULL,
  Done BOOLEAN NOT NULL DEFAULT FALSE,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ChecklistItems (
  Id BIGSERIAL PRIMARY KEY,
  UniversityId BIGINT REFERENCES Universities(Id) ON DELETE CASCADE,
  Title VARCHAR(200) NOT NULL,
  Details VARCHAR(600),
  Pos INT NOT NULL DEFAULT 100,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ChecklistDone (
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  ItemId BIGINT NOT NULL REFERENCES ChecklistItems(Id) ON DELETE CASCADE,
  PRIMARY KEY (StudentId, ItemId)
);
CREATE TABLE IF NOT EXISTS StudentSchedule (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  Kind VARCHAR(8) NOT NULL,
  Title VARCHAR(160) NOT NULL,
  DayNo INT,
  StartTime VARCHAR(8),
  Venue VARCHAR(80),
  ExamDate DATE
);
CREATE TABLE IF NOT EXISTS Materials (
  Id BIGSERIAL PRIMARY KEY,
  Subject VARCHAR(120) NOT NULL,
  Title VARCHAR(160) NOT NULL,
  Description VARCHAR(400),
  FileName VARCHAR(200) NOT NULL,
  MimeType VARCHAR(100) NOT NULL,
  SizeBytes INT NOT NULL,
  Data BYTEA NOT NULL,
  Status VARCHAR(12) NOT NULL DEFAULT 'pending',
  UploaderId BIGINT REFERENCES StudentProfiles(Id) ON DELETE SET NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS Listings (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  UniversityId BIGINT NOT NULL,
  Kind VARCHAR(12) NOT NULL,
  Title VARCHAR(160) NOT NULL,
  Details VARCHAR(800),
  Price VARCHAR(40),
  Status VARCHAR(12) NOT NULL DEFAULT 'pending',
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ScamAlerts (
  Id BIGSERIAL PRIMARY KEY,
  Title VARCHAR(160) NOT NULL,
  Details VARCHAR(1000),
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ChecklistItems (Title, Details, Pos)
SELECT v.t, v.d, v.p FROM (VALUES
  ('Check your admission status', 'Use the official school portal and JAMB CAPS only. Ignore admission lists sent by agents.', 1),
  ('Accept the admission on JAMB CAPS', 'Accept or reject within the time JAMB gives you.', 2),
  ('Pay the acceptance fee', 'Pay only on the school official portal and keep the receipt.', 3),
  ('Complete screening and document verification', 'Take your original credentials: O-level results, birth certificate, passport photos, JAMB result slip.', 4),
  ('Print your admission letter', 'Print it from the school portal after screening.', 5),
  ('Pay your school fees', 'Check the fee schedule on the official portal. Keep every receipt safe.', 6),
  ('Register your courses', 'Do it every semester, before the registration deadline.', 7),
  ('Get your matric number and student ID card', 'Needed for exams, library and hostel.', 8),
  ('Do your medical examination', 'Use the school health centre and keep the clearance slip.', 9),
  ('Sort out your hostel', 'Apply on campus early, or look for an off-campus room.', 10),
  ('Join your department and class WhatsApp groups', 'Ask your class rep so you do not miss notices.', 11)
) AS v(t, d, p) WHERE NOT EXISTS (SELECT 1 FROM ChecklistItems);

-- ===== Batch A/B/C: class notices, tasks, money, planner, contacts, groups, mentors, reports, sponsors, referrals, payments =====
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS IsRep BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS ClassTag VARCHAR(60);
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS RefCode VARCHAR(12);
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS ReferredBy BIGINT;
ALTER TABLE NewsArticles ADD COLUMN IF NOT EXISTS Verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS ClassNotices (
  Id BIGSERIAL PRIMARY KEY,
  UniversityId BIGINT NOT NULL,
  ClassTag VARCHAR(60) NOT NULL,
  Kind VARCHAR(12) NOT NULL DEFAULT 'notice',
  Title VARCHAR(160) NOT NULL,
  Body TEXT,
  DueDate DATE,
  AuthorId BIGINT,
  AuthorName VARCHAR(80),
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS IX_ClassNotices_Class ON ClassNotices (UniversityId, ClassTag, Id DESC);

CREATE TABLE IF NOT EXISTS StudentTasks (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  Course VARCHAR(80),
  Title VARCHAR(160) NOT NULL,
  Kind VARCHAR(12) NOT NULL DEFAULT 'assignment',
  DueDate DATE,
  Done BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS StudentMoney (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  Kind VARCHAR(3) NOT NULL,
  Amount INT NOT NULL,
  Label VARCHAR(80),
  OnDate DATE NOT NULL DEFAULT current_date
);

CREATE TABLE IF NOT EXISTS StudentPlans (
  StudentId BIGINT PRIMARY KEY REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  PlanText TEXT NOT NULL,
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS SupportContacts (
  Id BIGSERIAL PRIMARY KEY,
  Category VARCHAR(12) NOT NULL DEFAULT 'emergency',
  UniversityId BIGINT,
  Name VARCHAR(120) NOT NULL,
  Phone VARCHAR(40),
  Note VARCHAR(300)
);

CREATE TABLE IF NOT EXISTS StudyGroups (
  Id BIGSERIAL PRIMARY KEY,
  UniversityId BIGINT,
  Course VARCHAR(80) NOT NULL,
  Title VARCHAR(160) NOT NULL,
  Link VARCHAR(300) NOT NULL,
  Details VARCHAR(400),
  Status VARCHAR(10) NOT NULL DEFAULT 'pending',
  SubmittedBy BIGINT,
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS Mentors (
  Id BIGSERIAL PRIMARY KEY,
  Name VARCHAR(80) NOT NULL,
  UniversityId BIGINT,
  Programme VARCHAR(120),
  LevelText VARCHAR(40),
  Bio VARCHAR(500),
  Phone VARCHAR(30),
  Status VARCHAR(10) NOT NULL DEFAULT 'pending',
  SubmittedBy BIGINT,
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS PostReports (
  Id BIGSERIAL PRIMARY KEY,
  PostId VARCHAR(40) NOT NULL,
  StudentId BIGINT,
  Reason VARCHAR(300),
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS Sponsors (
  Id BIGSERIAL PRIMARY KEY,
  Title VARCHAR(120) NOT NULL,
  Body VARCHAR(300),
  Link VARCHAR(500),
  StartsOn DATE,
  EndsOn DATE,
  Clicks INT NOT NULL DEFAULT 0,
  Views INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Products (
  Id BIGSERIAL PRIMARY KEY,
  Name VARCHAR(120) NOT NULL,
  Description VARCHAR(400),
  AmountNaira INT NOT NULL,
  IsActive BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS Payments (
  Id BIGSERIAL PRIMARY KEY,
  Reference VARCHAR(60) NOT NULL UNIQUE,
  StudentId BIGINT NOT NULL,
  ProductId BIGINT NOT NULL,
  ProductName VARCHAR(120),
  AmountNaira INT NOT NULL,
  Status VARCHAR(10) NOT NULL DEFAULT 'pending',
  CreatedAt TIMESTAMP NOT NULL DEFAULT now(),
  PaidAt TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Broadcasts (
  Id BIGSERIAL PRIMARY KEY,
  Subject VARCHAR(160),
  Audience VARCHAR(80),
  Sent INT NOT NULL DEFAULT 0,
  Failed INT NOT NULL DEFAULT 0,
  Total INT NOT NULL DEFAULT 0,
  CreatedAt TIMESTAMP NOT NULL DEFAULT now()
);

-- ===== Premium, public leads, cyber cafes =====
ALTER TABLE StudentProfiles ADD COLUMN IF NOT EXISTS PremiumUntil DATE;
ALTER TABLE Products ADD COLUMN IF NOT EXISTS PremiumDays INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS PublicLeads (
  Id BIGSERIAL PRIMARY KEY,
  Kind VARCHAR(12) NOT NULL,
  Name VARCHAR(80) NOT NULL,
  Phone VARCHAR(30) NOT NULL,
  Message VARCHAR(800),
  ProductId BIGINT,
  Status VARCHAR(10) NOT NULL DEFAULT 'new',
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS Cafes (
  Id BIGSERIAL PRIMARY KEY,
  Name VARCHAR(120) NOT NULL,
  UniversityId BIGINT,
  Area VARCHAR(120),
  Address VARCHAR(240),
  Phone VARCHAR(30),
  Services VARCHAR(800),
  Hours VARCHAR(120),
  Email VARCHAR(120) NOT NULL UNIQUE,
  PasswordHash VARCHAR(300) NOT NULL,
  IsActive BOOLEAN NOT NULL DEFAULT TRUE,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS CafeSessions (
  TokenHash VARCHAR(100) PRIMARY KEY,
  CafeId BIGINT NOT NULL REFERENCES Cafes(Id) ON DELETE CASCADE,
  ExpiresAt TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS CafeQuestions (
  Id BIGSERIAL PRIMARY KEY,
  StudentId BIGINT NOT NULL REFERENCES StudentProfiles(Id) ON DELETE CASCADE,
  UniversityId BIGINT,
  CafeId BIGINT,
  Category VARCHAR(30) NOT NULL DEFAULT 'other',
  Title VARCHAR(160) NOT NULL,
  Body VARCHAR(1000),
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS CafeAnswers (
  Id BIGSERIAL PRIMARY KEY,
  QuestionId BIGINT NOT NULL REFERENCES CafeQuestions(Id) ON DELETE CASCADE,
  CafeId BIGINT NOT NULL REFERENCES Cafes(Id) ON DELETE CASCADE,
  Body VARCHAR(1500) NOT NULL,
  CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS IX_CafeAnswers_Q ON CafeAnswers (QuestionId);

-- Starter services (only when no service exists yet). Change or delete them in Admin > Owner tools > Payments.
INSERT INTO Products (Name, Description, AmountNaira, PremiumDays)
SELECT v.n, v.d, v.a, v.p FROM (VALUES
  ('Premium (30 days)', 'No adverts and 3 times higher limits on the AI tutor, study planner, CV and essay helpers.', 1500, 30),
  ('Admission processing help', 'We guide you step by step through your admission process.', 5000, 0),
  ('CV and cover letter writing', 'A professional CV and cover letter written for you.', 3000, 0),
  ('Scholarship application help', 'We review your documents and essay before you apply.', 4000, 0)
) AS v(n, d, a, p) WHERE NOT EXISTS (SELECT 1 FROM Products);

-- News drip: publish one queued official item every N minutes (0 = off), rotating between schools
ALTER TABLE NewsDeskSettings ADD COLUMN IF NOT EXISTS DripMinutes INT NOT NULL DEFAULT 0;
ALTER TABLE NewsDeskSettings ADD COLUMN IF NOT EXISTS DripLastRun TIMESTAMPTZ;

-- One-time default: switch the news drip on at 15 minutes (official sources only) the first time this runs.
UPDATE NewsDeskSettings SET DripMinutes = 15, AutoPublishOfficial = TRUE, AutoSearch = TRUE
WHERE Id = 1 AND DripMinutes = 0 AND DripLastRun IS NULL;

-- One-time: replace the starter services with the real service list (prices on request, amount 0).
CREATE TABLE IF NOT EXISTS SchemaFlags (Name VARCHAR(60) PRIMARY KEY);
WITH f AS (INSERT INTO SchemaFlags (Name) VALUES ('services_v2') ON CONFLICT DO NOTHING RETURNING 1),
d AS (DELETE FROM Products WHERE Name IN ('Admission processing help', 'CV and cover letter writing', 'Scholarship application help')
      AND EXISTS (SELECT 1 FROM f) AND NOT EXISTS (SELECT 1 FROM Payments pay WHERE pay.ProductId = Products.Id) RETURNING 1)
INSERT INTO Products (Name, Description, AmountNaira, PremiumDays)
SELECT v.n, v.d, 0, 0 FROM (VALUES
  ('Post UTME and screening registration', 'For all schools. We register you correctly and on time.'),
  ('Admission counselling and guidance', 'Advice on courses, schools, cut-off marks and your next steps.'),
  ('Printing of original JAMB result', 'Your official JAMB result printed and delivered.'),
  ('Printing of admission letters', 'Your admission letter printed from the portal.'),
  ('All institutions updates', 'Get the latest admission and school updates.'),
  ('WAEC scratch card', 'Get your WAEC result checker scratch card.'),
  ('NECO token', 'Get your NECO result checking token.'),
  ('Uploading of O-level result', 'We upload your O-level result on the school or JAMB portal.'),
  ('Combining of O-level results', 'We combine your O-level results on the portal for you.'),
  ('Uploading of documents for online clearance', 'We upload your documents for online clearance.'),
  ('Payment of acceptance fees', 'We pay your acceptance fee on the official portal and give you the receipt.'),
  ('Payment of school fees', 'We pay your school fees on the official portal and give you the receipt.'),
  ('Printing of documents on school portal', 'Any document you need printed from your school portal.'),
  ('Post UTME past questions for all schools', 'Past questions to practise before your screening.')
) AS v(n, d) WHERE EXISTS (SELECT 1 FROM f);
