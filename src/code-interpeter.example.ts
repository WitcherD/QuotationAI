import piston from "piston-client";

const codeInterpreter = piston({});

export async function testCodeInterpeterRun() {
    const pythonCodeToInvoke = `import sys
import datetime
import calendar
import json

def validateCustomerSchedulingParameters(year=None, month=None, day=None, hour=None, minute=None, duration_hours=None, frequency=None):
    errors = []
    print(year)
    print(month)
    print(day)
    print(hour)
    print(minute)
    print(duration_hours)
    print(frequency)
    
    if year is not None and month is not None and day is not None and hour is not None and minute is not None:
        from datetime import datetime, timedelta

        scheduling_time = datetime(year, month, day, hour, minute)
        current_time = datetime.utcnow() + timedelta(hours=8)  # Adjusting to GMT+8
        
        # Rule 1: Can't book an appointment less than 48 hours in advance for new clients.
        if scheduling_time < current_time + timedelta(hours=48):
            errors.append("Can't book an appointment less than 48 hours in advance for new clients.")
        
        # Rule 2: Appointments can only be booked up to 3 months in advance.
        max_scheduling_time = current_time + timedelta(days=90)
        if scheduling_time > max_scheduling_time:
            errors.append("Appointments can only be booked up to 3 months in advance.")

        # Rule 3: No appointments are available on Sundays.
        if scheduling_time.weekday() == 6:
            errors.append("No appointments are available on Sundays.")
        
        # Rule 4: Check for observed holidays (example placeholders, actual dates should be defined).
        observed_holidays = [datetime(year, 1, 1), datetime(year, 12, 25)]  # Example holidays
        if scheduling_time.date() in [holiday.date() for holiday in observed_holidays]:
            errors.append("Appointments cannot be scheduled on observed holidays.")
        
        # Rule 5: No appointments are available on Wednesdays between 1:00 PM and 3:00 PM.
        if scheduling_time.weekday() == 2 and scheduling_time.hour >= 13 and scheduling_time.hour < 15:
            errors.append("No appointments are available on Wednesdays between 1:00 PM and 3:00 PM.")
        
        # Rule 6: Appointments cannot exceed 2 hours in length.
        if duration_hours is not None and duration_hours > 2:
            errors.append("Appointments cannot exceed 2 hours in length.")
        
        # Rule 7: Each appointment requires a 15-minute buffer before and after for preparation and cleanup.
        earlier_start = scheduling_time - timedelta(minutes=15)
        later_end = scheduling_time + timedelta(hours=duration_hours, minutes=15)
        if duration_hours is not None and duration_hours <= 0:
            errors.append("Duration must be positive.")
        
        # Rule 8: Handling frequency rules for recurring appointments (if applicable).
        if frequency in ["Daily", "Weekly", "Monthly"] and year is not None and month is not None and day is not None:
            max_recurring_duration = current_time + timedelta(days=180)  # Max 6 months
            if scheduling_time > max_recurring_duration:
                errors.append("Recurring appointments cannot be scheduled for more than 6 months at a time.")

    return errors

def get_next_monday():
    """Returns the date of the next Monday."""
    from datetime import datetime, timedelta
    today = datetime.now()
    today_weekday = today.weekday()  # Monday is 0, Sunday is 6
    days_until_monday = (7 - today_weekday + 0) % 7 #0 is for monday. using modulo operator for correct calculation
    if days_until_monday == 0:
        days_until_monday = 7  # To get the next Monday if today is Monday
    next_monday = today + timedelta(days=days_until_monday)
    return next_monday

def getCustomerSchedulingParameters():
    """
    Returns scheduling parameters in GMT+8 timezone.

    Returns a dictionary with the following keys (all required):
        appointment_date: Day of the month (int or None)
        appointment_month: Month of the year (int or None)
        appointment_year: Year (int or None)
        appointment_time_hour: Hour of the day (int or None) - 24-hour format
        appointment_time_minute: Minute of the hour (int or None)
        duration_hours: Duration of the appointment (float or None)
        frequency: Frequency of the appointment (string or None) - "Adhoc", "Daily", "Weekly", "Monthly"
    """
    next_monday = get_next_monday()
    return {
        "appointment_date": next_monday.day,
        "appointment_month": next_monday.month,
        "appointment_year": next_monday.year,
        "appointment_time_hour": 14,
        "appointment_time_minute": 0,
        "duration_hours": None,
        "frequency": "Adhoc"
    }

parameters = getCustomerSchedulingParameters()
print(json.dumps(parameters))

valiation_errors = validateCustomerSchedulingParameters(parameters["appointment_year"], parameters["appointment_month"], parameters["appointment_date"], parameters["appointment_time_hour"], parameters["appointment_time_minute"], parameters["duration_hours"], parameters["frequency"])

print(json.dumps({"validation_errors": valiation_errors}))`;

    const result = await codeInterpreter.execute('python', pythonCodeToInvoke, { args: [] });
    console.log("codeInterpreter response", result);
}