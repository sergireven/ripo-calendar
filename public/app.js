// JavaScript mínim: calendari (FullCalendar) i selects que s'envien sols.
document.querySelectorAll('select[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

const el = document.getElementById('calendar');
if (el && window.FullCalendar) {
  const params = new URLSearchParams();
  if (el.dataset.team) params.set('equip', el.dataset.team);
  if (el.dataset.person) params.set('persona', el.dataset.person);
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  let saved = null;
  try { saved = localStorage.getItem('cal-view'); } catch { /* sense emmagatzematge */ }
  const cal = new FullCalendar.Calendar(el, {
    locale: 'ca',
    firstDay: 1,
    initialView: saved || (mobile ? 'listWeek' : 'timeGridWeek'),
    headerToolbar: mobile
      ? { left: 'prev,next', center: 'title', right: 'listWeek,dayGridMonth' }
      : { left: 'prev,next today', center: 'title', right: 'timeGridWeek,dayGridMonth,listWeek' },
    buttonText: { today: 'Avui', week: 'Setmana', month: 'Mes', list: 'Llista', listWeek: 'Llista', timeGridWeek: 'Setmana', dayGridMonth: 'Mes' },
    views: { timeGridWeek: { slotMinTime: '08:00:00', slotMaxTime: '23:00:00' } },
    allDaySlot: false,
    nowIndicator: true,
    height: 'auto',
    noEventsContent: 'Cap partit aquesta setmana',
    events: `/api/events?${params}`,
    viewDidMount: (info) => { try { localStorage.setItem('cal-view', info.view.type); } catch { /* res */ } },
  });
  cal.render();
}
